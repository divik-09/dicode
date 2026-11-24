import fs from 'node:fs';
import path from 'node:path';

/**
 * File checkpoints. Before any tool modifies a file we keep its previous bytes (or note it did not exist).
 * `undo()` restores every file touched in the most recent turn that changed something.
 * Shell side effects (rm, git, installs) cannot be undone this way.
 */
export function createCheckpoints({ maxTurns = 50 } = {}) {
  const turns = [];
  let current = null;
  const begin = (label) => {
    current = { label: String(label || '').slice(0, 80), at: Date.now(), files: new Map() };
    turns.push(current);
    if (turns.length > maxTurns) turns.shift();
  };
  return {
    begin,
    snapshot(abs) {
      if (!current) begin('edit');
      if (current.files.has(abs)) return;
      const existed = fs.existsSync(abs);
      current.files.set(abs, existed ? { existed: true, content: fs.readFileSync(abs) } : { existed: false });
    },
    undo() {
      while (turns.length) {
        const t = turns.pop();
        if (t === current) current = null;
        if (!t.files.size) continue;
        const restored = [];
        for (const [abs, snap] of t.files) {
          if (snap.existed) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, snap.content); restored.push({ file: abs, action: 'restored' }); }
          else if (fs.existsSync(abs)) { fs.rmSync(abs); restored.push({ file: abs, action: 'deleted' }); }
        }
        return { label: t.label, files: restored };
      }
      return null;
    },
    pending: () => turns.filter((t) => t.files.size).length,
  };
}
