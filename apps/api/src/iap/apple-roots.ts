// apps/api/src/iap/apple-roots.ts
//
// Apple Root CA - G3 — the root used by App Store Server Notifications V2.
// Source: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (DER) → PEM.
// Cert SHA-256 fingerprint (matches Apple's published value):
//   63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
// Valid 2014-04-30 → 2039-04-30.
//
// Module-load validation in apple-client.ts asserts that every PEM in
// APPLE_ROOT_CERTS parses as X.509 and that its SPKI SHA-256 is a member
// of EXPECTED_APPLE_ROOT_SPKI_SHA256. Re-deriving the hash:
//   openssl x509 -in AppleRootCA-G3.cer -inform DER -pubkey -noout \
//     | openssl pkey -pubin -outform DER \
//     | openssl dgst -sha256

export const APPLE_ROOT_CERTS: Buffer[] = [
  Buffer.from(
    `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`,
    "utf8",
  ),
];

/** SHA-256 of the SPKI (Subject Public Key Info) DER bytes of every
 *  trusted Apple root. Validation succeeds when at least one entry in
 *  APPLE_ROOT_CERTS hashes to a value in this set. Multiple entries
 *  allow root rotation: register the next root + hash here BEFORE
 *  Apple flips the signing chain, then retire the old one. */
export const EXPECTED_APPLE_ROOT_SPKI_SHA256: ReadonlyArray<string> = [
  "9b219d0fbff36a5fb32090571906bceea68617c833a3f61b81e962a8e64db8af",
];
