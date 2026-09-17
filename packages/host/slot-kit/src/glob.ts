/** Path glob: `*` one segment, `**` any depth. */
export function pathMatchesGlob(path: string, pattern: string): boolean {
  const posix = path.replaceAll("\\", "/");
  let source = "^";
  const spec = pattern.replaceAll("\\", "/");
  for (let i = 0; i < spec.length; ) {
    if (spec.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (spec.startsWith("**", i) && i + 2 === spec.length) {
      source += ".*";
      i += 2;
      continue;
    }
    const char = spec[i];
    if (char === undefined) {
      break;
    }
    if (char === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  source += "$";
  return new RegExp(source).test(posix);
}
