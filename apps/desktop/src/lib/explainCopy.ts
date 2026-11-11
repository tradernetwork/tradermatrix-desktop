/** Copy for the reply's Copy button (M16 B1): the reply as plain text, exactly as the model wrote it (no HTML wrapper). false = it could not be copied. */
export async function copyPlain(text: string): Promise<boolean> {
  try {
    const c = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator?.clipboard
    if (!c?.writeText) return false
    await c.writeText(text)
    return true
  } catch {
    return false
  }
}
