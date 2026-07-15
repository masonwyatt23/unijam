import { spawn } from "node:child_process";

function duration(value) {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) throw new Error(`Unsupported duration: ${value}`);
  const amount = Number(match[1]);
  return amount * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1);
}

const [, , timeoutValue, killAfterValue, command, ...args] = process.argv;
if (!timeoutValue || !killAfterValue || !command) {
  throw new Error("Usage: run-bounded.mjs <timeout> <kill-after> <command> [...args]");
}

const child = spawn(command, args, { stdio: "inherit", env: process.env });
let timedOut = false;
const timeoutHandle = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), duration(killAfterValue)).unref();
}, duration(timeoutValue));

child.once("error", (error) => {
  clearTimeout(timeoutHandle);
  throw error;
});

child.once("exit", (code, signal) => {
  clearTimeout(timeoutHandle);
  if (timedOut) {
    console.error(`Command exceeded ${timeoutValue} and was terminated.`);
    process.exit(124);
  }
  if (signal) {
    console.error(`Command exited after signal ${signal}.`);
    process.exit(128);
  }
  process.exit(code ?? 1);
});
