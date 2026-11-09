import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run, home } from "herdr";

// Git graph of every branch, tag and worktree in the focused pane's repo.
// Live: refs + worktrees are fingerprinted every POLL ms (and on folder changes);
// the log is only re-read when that fingerprint moves.

const POLL = 2000, DIRTY_EVERY = 5, MAX_COMMITS = 600;
const ROW = 24, LANE = 12, PAD = 8, MAX_LANES = 14;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const SEP = "\x1f", REC = "\x1e";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

function ago(sec) {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 60) return `${Math.floor(s / 604800)}w`;
  if (s < 86400 * 365) return `${Math.floor(s / 2592000)}mo`;
  return `${Math.floor(s / 31536000)}y`;
}

function parseWorktrees(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    const w = {};
    for (const line of block.split("\n")) {
      const [k, ...rest] = line.split(" "), v = rest.join(" ");
      if (k === "worktree") w.path = v;
      else if (k === "HEAD") w.head = v;
      else if (k === "branch") w.branch = v.replace(/^refs\/heads\//, "");
      else if (k === "detached") w.detached = true;
      else if (k === "bare") w.bare = true;
      else if (k === "locked") w.locked = true;
      else if (k === "prunable") w.prunable = true;
    }
    if (w.path && !w.bare) out.push({ ...w, name: w.path.split("/").pop() });
  }
  return out;
}

// Assigns each commit a lane and the line segments its row draws.
// Segments are in row-local px: y 0 = top edge, ROW/2 = the dot, ROW = bottom.
function layoutGraph(commits) {
  const X = (i) => PAD + i * LANE + LANE / 2, M = ROW / 2;
  let lanes = [], maxLanes = 1;
  const rows = commits.map((c) => {
    let col = lanes.indexOf(c.hash);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) { col = lanes.length; lanes.push(null); } }
    const segs = [];
    lanes.forEach((h, j) => {
      if (h === null) return;
      if (h === c.hash) segs.push({ x1: X(j), y1: 0, x2: X(col), y2: M, lane: j });
    });
    const next = lanes.map((h) => (h === c.hash ? null : h));
    const [first, ...rest] = c.parents;
    if (first) {
      const k = next.indexOf(first);
      if (k >= 0 && k !== col) segs.push({ x1: X(col), y1: M, x2: X(k), y2: ROW, lane: k });
      else { next[col] = first; segs.push({ x1: X(col), y1: M, x2: X(col), y2: ROW, lane: col }); }
    }
    for (const p of rest) {
      let k = next.indexOf(p);
      if (k < 0) { k = next.indexOf(null); if (k < 0 || k === col) { k = next.findIndex((h, i) => h === null && i !== col); } if (k < 0) { k = next.length; next.push(null); } next[k] = p; }
      segs.push({ x1: X(col), y1: M, x2: X(k), y2: ROW, lane: k });
    }
    // Lanes that just pass through this row.
    next.forEach((h, j) => { if (h !== null && lanes[j] === h && h !== c.hash) segs.push({ x1: X(j), y1: 0, x2: X(j), y2: ROW, lane: j }); });
    while (next.length && next[next.length - 1] === null) next.pop();
    lanes = next;
    maxLanes = Math.max(maxLanes, col + 1, lanes.length);
    return { col, segs };
  });
  return { rows, width: PAD * 2 + Math.min(maxLanes, MAX_LANES) * LANE };
}

function circle(cx, cy, r) {
  return PathBuilder.fill().move_to(cx - r, cy).arc_to(r, r, 0, false, true, cx + r, cy).arc_to(r, r, 0, false, true, cx - r, cy).close().build();
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.reset();
    this.tick = 0;
    this.refresh(cx, true);
    cx.timer.every(POLL, (cx) => { this.tick++; this.refresh(cx, false); });
  }

  reset() {
    this.root = null; this.on = null; this.commits = []; this.graph = { rows: [], width: PAD * 2 + LANE };
    this.worktrees = []; this.dirty = {}; this.track = {}; this.fp = null; this.selected = null; this.error = null; this.watched = null;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) { this.dirtyNow = true; this.refresh(cx, false); }
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx, force) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); force = true; }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
          if (key() !== context) return;
          if (top.code !== 0) { this.error = "Not a git repository"; return; }
          this.root = top.stdout.trim(); this.on = on;
        }
        const root = this.root, git = (args, dir = root) => exec("git", [...READ, ...args], { cwd: dir, on });
        const [refs, wts] = await Promise.all([
          git(["for-each-ref", "--format=%(objectname) %(refname) %(upstream:track)"]),
          git(["worktree", "list", "--porcelain"]),
        ]);
        if (key() !== context) return;
        if (refs.code !== 0) throw new Error(refs.stderr.trim());
        const fp = refs.stdout + REC + wts.stdout;
        const worktrees = parseWorktrees(wts.stdout);
        const changed = force || fp !== this.fp;

        if (changed) {
          const track = {}, locals = new Set();
          for (const line of refs.stdout.split("\n")) {
            const [, ref, ...t] = line.split(" ");
            if (!ref?.startsWith("refs/heads/")) continue;
            const b = ref.slice(11); locals.add(b);
            const s = t.join(" ");
            track[b] = { ahead: +(/ahead (\d+)/.exec(s)?.[1] ?? 0), behind: +(/behind (\d+)/.exec(s)?.[1] ?? 0), gone: s.includes("gone") };
          }
          const heads = [...new Set(worktrees.map((w) => w.head).filter(Boolean))];
          const log = await git(["log", "--topo-order", `--max-count=${MAX_COMMITS}`, "--no-color",
            `--format=%H${SEP}%P${SEP}%D${SEP}%s${SEP}%an${SEP}%ct${REC}`, "--branches", "--remotes", "--tags", "HEAD", ...heads, "--"]);
          if (key() !== context) return;
          if (log.code !== 0 && !/does not have any commits/.test(log.stderr)) throw new Error(log.stderr.trim());
          const byHead = {};
          for (const w of worktrees) (byHead[w.head] ??= []).push(w);
          const commits = log.code !== 0 ? [] : log.stdout.split(REC).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
            const [hash, parents, deco, subject, author, time] = r.split(SEP);
            const refs = [];
            for (let d of (deco || "").split(", ").filter(Boolean)) {
              if (d === "HEAD") continue;
              if (d.startsWith("HEAD -> ")) d = d.slice(8);
              if (d.startsWith("tag: ")) refs.push({ kind: "tag", name: d.slice(5) });
              else if (locals.has(d)) refs.push({ kind: "branch", name: d, worktree: worktrees.find((w) => w.branch === d) });
              else if (!d.endsWith("/HEAD")) refs.push({ kind: "remote", name: d });
            }
            // Detached worktrees get their own badge; ones on a branch mark that branch.
            for (const w of byHead[hash] ?? []) if (!w.branch) refs.unshift({ kind: "detached", name: w.name, worktree: w });
            return { hash, parents: parents ? parents.split(" ") : [], refs, subject, author, time: +time };
          });
          this.fp = fp; this.track = track; this.commits = commits; this.graph = layoutGraph(commits);
          this.worktrees = worktrees;
          if (this.selected && !commits.some((c) => c.hash === this.selected)) this.selected = null;
        }
        // Uncommitted changes per worktree: on ref moves, folder events, and every few polls.
        if (changed || this.dirtyNow || this.tick % DIRTY_EVERY === 0) {
          this.dirtyNow = false;
          const dirty = {};
          await Promise.all(worktrees.filter((w) => !w.prunable).map(async (w) => {
            const r = await git(["status", "--porcelain=v1", "--untracked-files=normal"], w.path).catch(() => null);
            dirty[w.path] = r?.code === 0 ? r.stdout.split("\n").filter(Boolean).length : null;
          }));
          if (key() !== context) return;
          this.dirty = dirty;
        }
        this.error = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  openWorktree(w) {
    const inside = (dir) => dir && (dir === w.path || dir.startsWith(w.path + "/"));
    const space = spaces().find((s) => inside(s.folder) || s.tabs?.some((t) => panes().some((p) => p.tab === t.id && inside(p.cwd))));
    if (space) run("space.select", { id: space.id });
    else run("space.new", { folder: w.path, ...(this.on ? { machine: this.on } : {}) });
  }

  showCommit(hash) {
    run("pane.split", { direction: "right", argv: ["git", "-C", this.root, "show", "--stat", "-p", hash] });
  }

  badge(r, t) {
    const current = r.worktree && r.worktree.path === this.root;
    const color = r.kind === "tag" ? t.ansi3 : r.kind === "remote" ? t.dim : r.worktree ? t.accent : t.ansi2;
    const label = (r.worktree ? "⌂ " : r.kind === "tag" ? "◆ " : "") + r.name;
    return div().flex_none().max_w(140).truncate().px(5).h(16).flex().items_center().rounded(4).text_size(10.5)
      .border_1().border_color(color + (current ? "" : "70")).text_color(color).when(current, (e) => e.bg(color + "22").font_semibold())
      .child(label);
  }

  row(i, t, palette) {
    const c = this.commits[i], g = this.graph.rows[i];
    const color = (lane) => palette[lane % palette.length];
    const byColor = {};
    for (const s of g.segs) (byColor[s.lane % palette.length] ??= []).push(s);
    const lines = Object.entries(byColor).map(([ci, segs]) => {
      let b = PathBuilder.stroke(1.6);
      for (const s of segs) {
        b = b.move_to(s.x1, s.y1);
        if (s.x1 === s.x2) b = b.line_to(s.x2, s.y2);
        else { const ym = (s.y1 + s.y2) / 2; b = b.cubic_bezier_to(s.x2, s.y2, s.x1, ym, s.x2, ym); }
      }
      return window.paint_path(b.build(), palette[ci]).absolute().top(0).left(0).size_full();
    });
    const x = PAD + g.col * LANE + LANE / 2, isWt = c.refs.some((r) => r.worktree);
    const here = this.worktrees.find((w) => w.path === this.root)?.head === c.hash;
    const dot = isWt || here
      ? [window.paint_path(circle(x, ROW / 2, 5), here ? t.accent : color(g.col)).absolute().top(0).left(0).size_full(),
         window.paint_path(circle(x, ROW / 2, 2.6), t.background).absolute().top(0).left(0).size_full()]
      : [window.paint_path(circle(x, ROW / 2, 3.6), color(g.col)).absolute().top(0).left(0).size_full()];
    const sel = this.selected === c.hash;
    return h_flex().w_full().h(ROW).flex_none().items_center().pr(10).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(div().w(this.graph.width).h(ROW).flex_none().relative().overflow_hidden().children([...lines, ...dot]))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center()
        .children(c.refs.slice(0, 4).map((r) => this.badge(r, t)))
        .when(c.refs.length > 4, (e) => e.child(div().text_size(10).text_color(t.dim).child(`+${c.refs.length - 4}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(c.refs.length ? t.foreground : t.muted).child(c.subject || "(no message)")))
      .child(div().flex_none().pl(8).text_size(10.5).text_color(t.dim).child(ago(c.time)));
  }

  worktreeRow(w, t) {
    const current = w.path === this.root, n = this.dirty[w.path], tr = (w.branch && this.track[w.branch]) || {};
    const short = w.path.startsWith(home()) ? "~" + w.path.slice(home().length) : w.path;
    return h_flex().id(`wt-${w.path}`).h(26).flex_none().px(8).gap(7).items_center().rounded(6).cursor_pointer()
      .when(current, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click(() => this.openWorktree(w))
      .child(div().size(7).flex_none().rounded(4).bg(current ? t.accent : n ? t.blocked : t.dim))
      .child(div().flex_none().max_w(150).truncate().font_semibold().when(!current, (e) => e.font_normal()).child(w.branch ?? `(${w.head?.slice(0, 7)})`))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(short))
      .when(tr.ahead > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`↑${tr.ahead}`)))
      .when(tr.behind > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`↓${tr.behind}`)))
      .when(Boolean(n), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(`●${n}`)))
      .when(Boolean(w.prunable), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child("missing")))
      .when(Boolean(w.locked), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("locked")));
  }

  detail(t) {
    const c = this.commits.find((x) => x.hash === this.selected);
    if (!c) return null;
    return v_flex().flex_none().p(10).gap(4).border_t(1).border_color(t.border).text_size(12)
      .child(div().text_color(t.foreground).child(c.subject))
      .child(h_flex().gap(8).text_size(11).text_color(t.dim)
        .child(div().font_family(settings().font_family ?? "JetBrains Mono").child(c.hash.slice(0, 10)))
        .child(div().flex_1().min_w(0).truncate().child(`${c.author} · ${new Date(c.time * 1000).toLocaleString()}`))
        .child(div().id("show-commit").px(8).h(22).flex().items_center().rounded(6).bg(t.raised).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => this.showCommit(c.hash)).child("Show")));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx, true);
    const t = theme();
    const palette = [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi13, t.ansi10, t.ansi11, t.ansi14, t.ansi9];
    const repo = this.worktrees[0]?.name ?? this.root?.split("/").pop() ?? "";
    const n = this.commits.length;
    const wtHeight = Math.min(this.worktrees.length, 6) * 26 + 12;
    return v_flex().id("git-graph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Graph"))
        .when(Boolean(repo), (e) => e.child(div().min_w(0).truncate().text_color(t.muted).child(repo)))
        .child(div().flex_1())
        .when(this.worktrees.length > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(`${this.worktrees.length} worktree${this.worktrees.length === 1 ? "" : "s"}`)))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${n}${n >= MAX_COMMITS ? "+" : ""} commits`)))
      .when(this.worktrees.length > 0, (e) => e.child(div().flex_none().h(wtHeight).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("graph-worktrees").absolute().inset_0().overflow_y_scroll().p(6).children(this.worktrees.map((w) => this.worktreeRow(w, t))))
        .child(Scrollbar.vertical("graph-worktrees").absolute().inset_0())))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("graph-commits", n, ROW, (i) => this.commits[i].hash, (range) => {
          const out = [];
          for (let i = range.start; i < range.end; i++) out.push(this.row(i, t, palette));
          return out;
        }).size_full().on_item_click((hash, cx) => { this.selected = this.selected === hash ? null : hash; cx.notify(); }))
        .child(Scrollbar.vertical("graph-commits").viewport_from_layout().absolute().inset_0())
        .when(!n, (e) => e.child(div().absolute().top(8).px(14).text_color(t.dim).child(this.error || (this.loading || !this.context ? "Loading graph…" : this.root ? "No commits yet" : "No folder")))))
      .when(Boolean(this.error && n), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.ansi1).truncate().child(this.error)))
      .when(Boolean(this.selected), (e) => { const d = this.detail(t); return d ? e.child(d) : e; });
  }
}
