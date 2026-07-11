/**
 * Zero-dependency terminal flair for the merrymen CLI — Sherwood green, an
 * arrow-flight banner, a bow-draw spinner, and a checklist. Everything is
 * TTY-guarded: piped/non-interactive output degrades to plain lines with no
 * escape codes and no timers, so logs stay clean and CI never hangs.
 */

const TTY = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.MERRYMEN_NO_ANIM;

export const c = {
  green: (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s),
  lime: (s) => (TTY ? `\x1b[92m${s}\x1b[0m` : s),
  red: (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s),
  gold: (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s),
  arrow: "➳", // ➳
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (s) => process.stdout.write(s);

const LOGO = [
  "                                                    ",
  "   ┏┳┓┏━┓┏━┓┏━┓╻ ╻┏┳┓┏━┓┏┓╻   ",
  "   ┃┃┃┣╸ ┣┳┛┣┳┛┗┳┛┃┃┃┣╸ ┃┗┫   ",
  "   ╹ ╹┗━╸╹┗╸╹┗╸ ╹ ╹ ╹┗━╸╹ ╹   ",
];

/**
 * Animated intro: an arrow flies across, then the wordmark drops in green.
 * Falls back to a one-line static banner when not a TTY.
 */
export async function banner(subtitle = "your band works Sherwood 24/7") {
  if (!TTY) {
    console.log(`${c.arrow} merrymen — ${subtitle}`);
    return;
  }
  const width = 34;
  // arrow flight
  for (let i = 0; i <= width; i += 2) {
    write("\r  " + c.dim("·".repeat(i)) + c.lime(c.arrow) + " ".repeat(Math.max(0, width - i)));
    await sleep(14);
  }
  write("\r" + " ".repeat(width + 6) + "\r");
  // wordmark reveal, line by line
  for (const line of LOGO) {
    console.log(c.green(line));
    await sleep(55);
  }
  console.log("   " + c.gold(c.arrow) + "  " + c.dim(subtitle) + "\n");
}

const SPIN = ["🏹    ", "·🏹   ", "··🏹  ", "···🏹 ", "····🏹", "───►◎"];

/**
 * Bow-draw spinner. Returns handles to finish it. In non-TTY mode it prints a
 * single start line and the finish line, no animation.
 */
export function spinner(text) {
  if (!TTY) {
    console.log(`  … ${text}`);
    return {
      succeed: (m) => console.log(`  ${c.green("✓")} ${m ?? text}`),
      fail: (m) => console.log(`  ${c.red("✗")} ${m ?? text}`),
      update: () => {},
      stop: () => {},
    };
  }
  let i = 0;
  let label = text;
  const id = setInterval(() => {
    write(`\r  ${c.gold(SPIN[i % SPIN.length])} ${label} `);
    i++;
  }, 90);
  const end = (mark, m) => {
    clearInterval(id);
    write(`\r  ${mark} ${m ?? label}${" ".repeat(8)}\n`);
  };
  return {
    succeed: (m) => end(c.green("✓"), m),
    fail: (m) => end(c.red("✗"), m),
    update: (m) => {
      label = m;
    },
    stop: () => {
      clearInterval(id);
      write("\r" + " ".repeat(label.length + 12) + "\r");
    },
  };
}

/** Run an async task under a spinner; auto-succeed/fail. */
export async function withSpinner(text, fn, okMsg) {
  const s = spinner(text);
  try {
    const out = await fn(s);
    s.succeed(okMsg ?? text);
    return out;
  } catch (e) {
    s.fail(`${text} — ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/** Type text out character by character (skipped when not a TTY). */
export async function type(text, cps = 220) {
  if (!TTY) {
    console.log(text);
    return;
  }
  const delay = 1000 / cps;
  for (const ch of text) {
    write(ch);
    if (ch !== " ") await sleep(delay);
  }
  write("\n");
}
