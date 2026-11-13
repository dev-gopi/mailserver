import QRCode from "qrcode";

/** Generate a standards-compliant SVG QR code with capacity chosen by the library. */
export async function generateQrSvg(text: string, scale = 4, margin = 4): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin,
    scale,
    color: { dark: "#0f172a", light: "#ffffff" }
  });
}
