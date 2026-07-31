const CONTEXT = 3;

type Op = { type: "equal" | "del" | "add"; line: string };

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

function hunkRange(position: number[], start: number, end: number): string {
  const count = position[end + 1]! - position[start]!;
  const first = count === 0 ? position[start]! : position[start]! + 1;
  return `${first},${count}`;
}

export function unifiedDiff(
  oldText: string,
  newText: string,
  label: string,
): string {
  if (oldText === newText) return "";

  const ops = diffOps(splitLines(oldText), splitLines(newText));

  const changed = ops
    .map((op, index) => (op.type === "equal" ? -1 : index))
    .filter((index) => index >= 0);
  const groups: [number, number][] = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] <= CONTEXT * 2) last[1] = index;
    else groups.push([index, index]);
  }

  const oldPos: number[] = new Array(ops.length + 1);
  const newPos: number[] = new Array(ops.length + 1);
  let oldLine = 0;
  let newLine = 0;
  ops.forEach((op, index) => {
    oldPos[index] = oldLine;
    newPos[index] = newLine;
    if (op.type !== "add") oldLine++;
    if (op.type !== "del") newLine++;
  });
  oldPos[ops.length] = oldLine;
  newPos[ops.length] = newLine;

  let output = `--- a/${label}\n+++ b/${label}\n`;
  for (const [groupStart, groupEnd] of groups) {
    const start = Math.max(0, groupStart - CONTEXT);
    const end = Math.min(ops.length - 1, groupEnd + CONTEXT);
    output += `@@ -${hunkRange(oldPos, start, end)} +${hunkRange(newPos, start, end)} @@\n`;
    for (let index = start; index <= end; index++) {
      const op = ops[index]!;
      const prefix = op.type === "equal" ? " " : op.type === "del" ? "-" : "+";
      output += `${prefix}${op.line}\n`;
    }
  }
  return output;
}
