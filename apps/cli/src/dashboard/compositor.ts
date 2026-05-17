import { computeLayout, type DashboardLayout } from './layout.js';
import { diffFrame } from './renderer.js';
import { InputParser } from './input.js';
import {
  PtySession,
  MOUSE_ENABLE_SEQ,
  MOUSE_DISABLE_SEQ,
  type PtySpawn,
  type TerminalCtor,
} from './pty-session.js';
import { sidebarLines, statusLine, menuLines, type SidebarBox } from './sidebar.js';

export type RightTarget =
  | { kind: 'attach'; argv: string[]; mode?: 'claude' | 'shell' }
  | { kind: 'menu' }
  | { kind: 'placeholder'; lines: string[] };

export interface CompositorDeps {
  ptySpawn: PtySpawn;
  termCtor: TerminalCtor;
  /** Scoped + sorted candidate boxes (same order the sidebar renders). */
  listCandidates: () => Promise<SidebarBox[]>;
  /** What the right pane should show for a box (attach argv / menu / message). */
  resolveTarget: (boxId: string) => Promise<RightTarget>;
  /** Start a proper Claude tmux session in the box, then resolve to attach. */
  startClaude: (boxId: string) => Promise<RightTarget>;
  /** Open an interactive shell in the box, resolve to attach. */
  openShell: (boxId: string) => Promise<RightTarget>;
  /** Host-side actions for the selected box; return a short status message. */
  openVnc: (boxId: string) => Promise<string>;
  openCode: (boxId: string) => Promise<string>;
  openWeb: (boxId: string) => Promise<string>;
}

const POLL_MS = 1000;
const FRAME_MS = 16;
const RESIZE_DEBOUNCE_MS = 120;

// Synchronized Output (DECSET 2026): the terminal buffers everything between
// begin/end and presents it in one go — no partial-frame flicker/tearing.
// Unsupported terminals ignore the unknown private mode.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

function cursorTo(x: number, y: number): string {
  return `\x1b[${String(y + 1)};${String(x + 1)}H`;
}

export class Compositor {
  private readonly out = process.stdout;
  private readonly inp = process.stdin;
  private boxes: SidebarBox[] = [];
  private selectedId: string;
  private session: PtySession | null = null;
  private placeholder: string[] | null = null;
  private menu: { boxName: string } | null = null;
  private activeMode: 'claude' | 'shell' = 'claude';
  private flashMsg: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a start-Claude / open-shell action is in flight (suppresses
   * the poll respawn so it can't interrupt the transition). */
  private busy = false;
  private layout: DashboardLayout;
  private prevRows: string[] | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly parser: InputParser;
  private tornDown = false;
  private resolveDone: (() => void) | null = null;
  private readonly onData = (d: Buffer): void => this.parser.feed(d);
  private readonly onResize = (): void => this.scheduleResize();
  private readonly onSig = (): void => {
    this.teardown();
    process.exit(0);
  };
  private readonly onFatal = (err: unknown): void => {
    this.teardown();
    process.stderr.write(`dashboard: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  };

  constructor(
    private readonly deps: CompositorDeps,
    initialId: string,
  ) {
    this.selectedId = initialId;
    this.layout = computeLayout(this.out.columns ?? 100, this.out.rows ?? 30);
    this.parser = new InputParser({
      onEvent: (e) => {
        if (e.type === 'quit') this.onSig();
        else if (e.type === 'switch') this.switchBox(e.dir);
        else if (e.type === 'action') void this.doAction(e.name);
        else if (this.menu) this.handleMenuKey(e.bytes);
        else this.session?.write(e.bytes);
      },
      // Absolute 1-based host coords → right-pane-local 1-based; null = the
      // pointer is over the sidebar/status, so Claude shouldn't see it.
      mouseTransform: (x, y) => {
        const r = this.layout.right;
        if (!this.session || this.layout.tooSmall) return null;
        const lx = x - r.x;
        const ly = y - r.y;
        if (lx < 1 || ly < 1 || lx > r.w || ly > r.h) return null;
        return { x: lx, y: ly };
      },
    });
  }

  async run(): Promise<void> {
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J' + MOUSE_ENABLE_SEQ);
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.on('data', this.onData);
    this.out.on('resize', this.onResize);
    process.once('SIGINT', this.onSig);
    process.once('SIGTERM', this.onSig);
    process.once('uncaughtException', this.onFatal);
    process.once('unhandledRejection', this.onFatal);
    process.once('exit', () => this.teardown());

    await this.refreshBoxes();
    if (!this.boxes.some((b) => b.id === this.selectedId) && this.boxes[0]) {
      this.selectedId = this.boxes[0].id;
    }
    await this.spawnActive();
    this.drawChrome();
    this.scheduleRender();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);

    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  private async refreshBoxes(): Promise<void> {
    try {
      this.boxes = await this.deps.listCandidates();
    } catch {
      /* keep last known list */
    }
  }

  private selectedBox(): SidebarBox | undefined {
    return this.boxes.find((b) => b.id === this.selectedId);
  }

  private async poll(): Promise<void> {
    const before = JSON.stringify(this.boxes.map((b) => [b.id, b.state, b.claudeActivity]));
    await this.refreshBoxes();
    if (this.busy) {
      // A start/shell action is mid-flight — don't yank the right pane.
    } else if (!this.boxes.some((b) => b.id === this.selectedId) && this.boxes[0]) {
      this.selectedId = this.boxes[0].id;
      await this.spawnActive();
    } else {
      // Re-resolve when: an attached box died; a not-running placeholder
      // recovered; or the menu's box stopped. The menu itself is a stable
      // state while its box runs — never respawn it (would reset the screen).
      const box = this.selectedBox();
      const running = box?.state === 'running';
      const reresolve =
        (this.session && !running) ||
        (this.placeholder && running) ||
        (this.menu && !running);
      if (reresolve) await this.spawnActive();
    }
    if (JSON.stringify(this.boxes.map((b) => [b.id, b.state, b.claudeActivity])) !== before) {
      this.drawChrome();
    }
  }

  private disposeSession(): void {
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
  }

  private async spawnActive(): Promise<void> {
    this.disposeSession();
    this.placeholder = null;
    this.menu = null;
    // Wipe the old agent now (synchronous, before the async resolve gap) so it
    // can't bleed through while the new attach redraws. Also resets prevRows.
    this.clearRightPane();
    const id = this.selectedId;
    const target = await this.deps.resolveTarget(id);
    if (this.selectedId !== id || this.tornDown) return; // user switched away
    this.applyTarget(target);
  }

  /** Turn a resolved/started target into the right-pane state. */
  private applyTarget(target: RightTarget): void {
    this.disposeSession();
    this.placeholder = null;
    this.menu = null;
    if (target.kind === 'attach') {
      this.activeMode = target.mode ?? 'claude';
      this.session = new PtySession(
        this.deps.ptySpawn,
        this.deps.termCtor,
        target.argv,
        Math.max(1, this.layout.right.w),
        Math.max(1, this.layout.right.h),
        () => this.scheduleRender(),
        () => this.onSessionExit(),
      );
    } else if (target.kind === 'menu') {
      this.menu = { boxName: this.selectedBox()?.name ?? this.selectedId };
    } else {
      this.placeholder = target.lines;
    }
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
  }

  private handleMenuKey(bytes: Buffer): void {
    for (const b of bytes) {
      if (b === 0x63 || b === 0x0d || b === 0x0a) {
        void this.chooseAction('claude');
        return;
      }
      if (b === 0x73) {
        void this.chooseAction('shell');
        return;
      }
    }
  }

  private async chooseAction(which: 'claude' | 'shell'): Promise<void> {
    if (this.busy) return;
    const id = this.selectedId;
    const name = this.selectedBox()?.name ?? id;
    this.busy = true;
    this.menu = null;
    this.placeholder = ['', which === 'claude' ? '  Starting Claude…' : '  Opening shell…'];
    this.prevRows = null;
    this.drawChrome();
    this.scheduleRender();
    try {
      const target =
        which === 'claude'
          ? await this.deps.startClaude(id)
          : await this.deps.openShell(id);
      if (this.selectedId !== id || this.tornDown) return; // switched away
      this.applyTarget(target);
    } catch (err) {
      if (this.selectedId !== id || this.tornDown) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.placeholder = [
        '',
        `  Failed to ${which === 'claude' ? 'start Claude' : 'open a shell'} in ${name}:`,
        `  ${msg}`,
        '',
        which === 'claude'
          ? `  Try from a shell: agentbox claude start ${name}`
          : `  Try from a shell: agentbox shell ${name}`,
      ];
      this.prevRows = null;
      this.scheduleRender();
    } finally {
      this.busy = false;
    }
  }

  private async doAction(name: 'vnc' | 'code' | 'web'): Promise<void> {
    const id = this.selectedId;
    let msg: string;
    try {
      msg =
        name === 'vnc'
          ? await this.deps.openVnc(id)
          : name === 'code'
            ? await this.deps.openCode(id)
            : await this.deps.openWeb(id);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    this.flash(msg);
  }

  /** Briefly show `msg` in the status row, then revert. */
  private flash(msg: string): void {
    this.flashMsg = msg;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.flashMsg = null;
      this.drawChrome();
    }, 2500);
    this.drawChrome();
  }

  private onSessionExit(): void {
    // Inner attach ended (container died / tmux session gone). Show a message;
    // the next poll reconciles box state.
    this.disposeSession();
    this.placeholder = ['', '  session ended — Ctrl-a ↑/↓ to switch boxes'];
    this.prevRows = null;
    this.scheduleRender();
  }

  private switchBox(dir: 'next' | 'prev'): void {
    if (this.boxes.length === 0) return;
    const i = Math.max(
      0,
      this.boxes.findIndex((b) => b.id === this.selectedId),
    );
    const n = this.boxes.length;
    const next = dir === 'prev' ? (i - 1 + n) % n : (i + 1) % n;
    this.selectedId = this.boxes[next]!.id;
    this.drawChrome();
    void this.spawnActive();
  }

  /** Blank the right pane and drop the diff cache (next paint is full). */
  private clearRightPane(): void {
    const r = this.layout.right;
    let s = SYNC_BEGIN + '\x1b[?25l';
    for (let i = 0; i < r.h; i++) {
      s += cursorTo(r.x, r.y + i) + '\x1b[0m' + ' '.repeat(r.w);
    }
    this.out.write(s + SYNC_END);
    this.prevRows = null;
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.tornDown) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, FRAME_MS);
  }

  private render(): void {
    if (this.tornDown) return;
    const r = this.layout.right;
    if (this.layout.tooSmall) {
      this.out.write(cursorTo(0, 0) + '\x1b[2J' + cursorTo(0, 0) + 'terminal too small');
      return;
    }
    if (this.session) {
      const { out, rows } = diffFrame(this.prevRows, this.session.snapshot(), r);
      this.prevRows = rows;
      if (out) this.out.write(SYNC_BEGIN + out + SYNC_END);
    } else if (this.menu) {
      const lines = menuLines(this.menu.boxName, r.w, r.h);
      let s = SYNC_BEGIN + '\x1b[?25l';
      for (let i = 0; i < r.h; i++) s += cursorTo(r.x, r.y + i) + '\x1b[0m' + (lines[i] ?? '');
      this.out.write(s + SYNC_END);
    } else if (this.placeholder) {
      let s = SYNC_BEGIN + '\x1b[?25l';
      for (let i = 0; i < r.h; i++) {
        const line = (this.placeholder[i] ?? '').slice(0, r.w);
        s += cursorTo(r.x, r.y + i) + '\x1b[0m' + line + ' '.repeat(Math.max(0, r.w - line.length));
      }
      this.out.write(s + SYNC_END);
    }
  }

  private drawChrome(): void {
    if (this.tornDown || this.layout.tooSmall) return;
    const { sidebar, sepX, statusY } = this.layout;
    const lines = sidebarLines(this.boxes, this.selectedId, sidebar.w, sidebar.h);
    let s = SYNC_BEGIN + '\x1b[0m';
    for (let i = 0; i < lines.length; i++) s += cursorTo(0, i) + lines[i];
    for (let y = 0; y < sidebar.h; y++) s += cursorTo(sepX, y) + '│';
    let status: string;
    if (this.flashMsg) {
      const w = this.layout.cols;
      const txt = ` ${this.flashMsg} `.slice(0, w).padEnd(w);
      status = `\x1b[7m${txt}\x1b[0m`;
    } else {
      const stateLabel = this.menu
        ? 'menu'
        : this.session && this.activeMode === 'shell'
          ? 'shell'
          : undefined;
      status = statusLine(this.selectedBox(), this.layout.cols, stateLabel);
    }
    s += cursorTo(0, statusY) + status;
    this.out.write(s + SYNC_END);
  }

  private scheduleResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.layout = computeLayout(this.out.columns ?? 100, this.out.rows ?? 30);
      this.prevRows = null;
      const r = this.layout.right;
      if (this.session && !this.layout.tooSmall) {
        this.session.resize(Math.max(1, r.w), Math.max(1, r.h));
      }
      this.out.write(SYNC_BEGIN + '\x1b[2J' + SYNC_END);
      this.drawChrome();
      this.render();
    }, RESIZE_DEBOUNCE_MS);
  }

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.parser.dispose();
    this.disposeSession();
    this.inp.off('data', this.onData);
    this.out.off('resize', this.onResize);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.inp.pause();
    // Belt-and-suspenders: clear the whole mouse-mode family in case Claude
    // enabled one we didn't individually track.
    this.out.write(MOUSE_DISABLE_SEQ + '\x1b[?25h\x1b[0m\x1b[?1049l');
    this.resolveDone?.();
  }
}
