/** Glob -> RegExp. Supports **, *, ?, [abc], {a,b}. Paths use forward slashes. */
export function globToRegExp(glob) {
  let re = '';
  let brace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; brace++; }
    else if (c === '}' && brace) { re += ')'; brace--; }
    else if (c === ',' && brace) re += '|';
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j > i + 1) { re += '[' + glob.slice(i + 1, j).replace(/\\/g, '\\\\') + ']'; i = j; } else re += '\\[';
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** A pattern without a slash matches at any depth ("*.ts" == "**\/*.ts"), like .gitignore. */
export function matchGlob(pattern, relPath) {
  const p = pattern.replace(/^\.\//, '');
  return globToRegExp(p.includes('/') ? p : '**/' + p).test(relPath.split('\\').join('/'));
}
