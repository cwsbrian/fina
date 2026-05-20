import { useEffect, useRef, useState } from "react";
import {
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputKeyPressEventData,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AuthScaffold } from "../../src/design/AuthScaffold";
import { Icon } from "../../src/design/Icon";
import { authClient } from "../../src/auth/client";
import { colors, type } from "../../src/design/tokens";

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

export default function VerifyScreen() {
  const params = useLocalSearchParams<{ email?: string }>();
  const email = params.email ?? "your email";

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [activeIndex, setActiveIndex] = useState(0);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputs = useRef<Array<TextInput | null>>([]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  function setAt(idx: number, value: string) {
    const v = value.replace(/[^0-9]/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[idx] = v;
      // Auto-submit the moment the 6th digit lands.
      if (v && idx === OTP_LENGTH - 1 && next.every((d) => d.length === 1)) {
        void verify(next.join(""));
      }
      return next;
    });
    if (v && idx < OTP_LENGTH - 1) {
      inputs.current[idx + 1]?.focus();
      setActiveIndex(idx + 1);
    }
  }

  async function verify(code: string) {
    if (busy) return;
    if (!params.email) {
      setErr("Missing email — go back and sign up again.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await authClient.emailOtp.verifyEmail({
        email: params.email,
        otp: code,
      });
      if (res.error) {
        throw new Error(res.error.message ?? "Code didn't match");
      }
      router.replace("/(tabs)");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not verify code");
      // Clear digits so the user can re-enter without backspacing each.
      setDigits(Array(OTP_LENGTH).fill(""));
      setActiveIndex(0);
      inputs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  }

  function onKeyPress(
    idx: number,
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) {
    if (e.nativeEvent.key === "Backspace" && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
      setActiveIndex(idx - 1);
    }
  }

  async function resend() {
    if (cooldown > 0 || busy || !params.email) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: params.email,
        type: "email-verification",
      });
      if (res.error) {
        throw new Error(res.error.message ?? "Could not resend code");
      }
      setCooldown(RESEND_SECONDS);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not resend code");
    } finally {
      setBusy(false);
    }
  }

  const mm = Math.floor(cooldown / 60);
  const ss = String(cooldown % 60).padStart(2, "0");

  return (
    <AuthScaffold>
      <View style={styles.head}>
        <View style={styles.illo}>
          <Icon name="mailOpen" size={28} color={colors.primary} strokeWidth={1.6} />
        </View>
        <Text style={styles.title}>Check your email.</Text>
        <Text style={styles.sub}>
          We sent a 6-digit code to{" "}
          <Text style={styles.subStrong}>{email}</Text>. It expires in 10
          minutes.
        </Text>
      </View>

      <View style={styles.otpRow}>
        {digits.map((d, i) => (
          <View
            key={i}
            style={[
              styles.box,
              d ? styles.boxFilled : null,
              i === activeIndex ? styles.boxActive : null,
            ]}
          >
            <TextInput
              ref={(el) => {
                inputs.current[i] = el;
              }}
              value={d}
              onChangeText={(v) => setAt(i, v)}
              onKeyPress={(e) => onKeyPress(i, e)}
              onFocus={() => setActiveIndex(i)}
              keyboardType="number-pad"
              maxLength={1}
              style={styles.boxInput}
              textContentType="oneTimeCode"
              selectTextOnFocus
            />
          </View>
        ))}
      </View>

      {err && <Text style={styles.errorText}>{err}</Text>}

      <Text style={styles.resend}>
        {cooldown > 0 ? (
          <>
            Resend code in{" "}
            <Text style={styles.resendStrong}>
              {mm}:{ss}
            </Text>
          </>
        ) : (
          <Text style={styles.resendLink} onPress={resend}>
            Resend code
          </Text>
        )}
      </Text>

      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Text style={styles.footText}>
          Wrong address? <Text style={styles.footLink}>Change email</Text>
        </Text>
      </Pressable>
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  head: { marginTop: 36 },
  illo: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: "rgba(59,123,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  title: { ...type.authTitle, color: colors.ink },
  sub: { ...type.bodyMd, color: colors.body, marginTop: 8 },
  subStrong: { color: colors.ink, fontWeight: "600" },
  otpRow: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    marginTop: 28,
  },
  box: {
    flex: 1,
    height: 60,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1.5,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  boxFilled: {
    backgroundColor: colors.canvas,
    borderColor: colors.hairline,
  },
  boxActive: {
    backgroundColor: colors.canvas,
    borderColor: colors.ink,
  },
  boxInput: {
    ...type.otpDigit,
    color: colors.ink,
    textAlign: "center",
    width: "100%",
    height: "100%",
  },
  errorText: {
    marginTop: 16,
    ...type.bodySm,
    color: colors.down,
    textAlign: "center",
  },
  resend: {
    marginTop: 20,
    ...type.bodySm,
    color: colors.muted,
    textAlign: "center",
  },
  resendStrong: { color: colors.body, fontWeight: "500" },
  resendLink: { color: colors.primary, fontWeight: "600" },
  footText: {
    ...type.bodySm,
    color: colors.muted,
    marginTop: 14,
    textAlign: "center",
  },
  footLink: { color: colors.primary, fontWeight: "600" },
});
