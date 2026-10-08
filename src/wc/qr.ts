/** WalletConnect pairing URI -> scannable QR. No MCP imports. */

import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";

/** Base64 PNG (no data: prefix) for embedding in an MCP image content block. */
export async function toPng(uri: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 512, errorCorrectionLevel: "M" });
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

/**
 * The QR code as block characters, for a client that shows text better than an image. Four modules of quiet zone, two
 * modules per line. The text is space, the upper half block, the lower half block, the full block and newlines, every
 * line the same width, with no newline at the end. The library's `small` option is not passed: its types accept it only
 * for the terminal renderer, and the utf8 renderer ignores it (it reads only the margin and the colours), so the output
 * is the same with or without it.
 */
export function toBlockText(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: "utf8", errorCorrectionLevel: "M" });
}

/** ASCII QR for the terminal (`moi-mcp pair`). */
export function toTerminal(uri: string, small = true): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(uri, { small }, (art: string) => resolve(art));
  });
}
