export const RECOVERY_CODE_FILENAME = "unijam-recovery-codes.txt";

export function formatRecoveryCodeFile(codes: readonly string[]): string {
  return [
    "UNIJAM RECOVERY CODES",
    "",
    "Keep these private. Each code can be used once to recover your UniJam account.",
    "Move this file to a password manager or encrypted vault, then delete it from Downloads.",
    "",
    ...codes.map((code, index) => `${String(index + 1).padStart(2, "0")}. ${code}`),
    "",
  ].join("\n");
}
