import { readFileSync } from "node:fs";

const TLS_CA_CERT_PATH = process.env.TLS_CA_CERT_PATH;
const TLS_INSECURE_OPT_IN = process.env.FHS_TLS_INSECURE === "true";

let _warnedInsecure = false;

export function wsOptions(url: string): { ca?: Buffer; rejectUnauthorized?: boolean } | undefined {
  if (!url.startsWith("wss://")) return undefined;
  if (TLS_CA_CERT_PATH) {
    return { ca: readFileSync(TLS_CA_CERT_PATH) };
  }
  if (TLS_INSECURE_OPT_IN) {
    if (!_warnedInsecure) {
      console.warn("[ws-security] FHS_TLS_INSECURE=true — verificación TLS desactivada (opt-in explícito)");
      _warnedInsecure = true;
    }
    // lgtm[js/disabling-certificate-validation]: opt-in explícito con FHS_TLS_INSECURE=true
    return { rejectUnauthorized: false };
  }
  return undefined;
}
