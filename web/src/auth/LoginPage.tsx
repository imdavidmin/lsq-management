import { useState } from "react";
import {
  Button,
  Card,
  Field,
  Input,
  Text,
  Title2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ApiError, request } from "../api/client";
import { OTP_LENGTH, OTP_PATTERN } from "../../../common/auth";
import { useAuth } from "./AuthProvider";

const useStyles = makeStyles({
  root: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: { width: "360px", padding: tokens.spacingVerticalXXL, gap: tokens.spacingVerticalL },
  form: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
});

export function LoginPage() {
  const s = useStyles();
  const { refresh } = useAuth();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Always 204 (no account enumeration) — advance regardless.
      await request<void>("/auth/otp/request", { method: "POST", body: { email } });
      setStep("code");
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request("/auth/otp/verify", { method: "POST", body: { email, code } });
      await refresh(); // cookie is set; load identity → app renders
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts. Wait a moment and try again."
          : "That code didn't work. Check it and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.root}>
      <Card className={s.card}>
        <Title2>Lansbury Square</Title2>
        {step === "email" ? (
          <form className={s.form} onSubmit={requestCode}>
            <Text>Enter your email and we'll send you a login code.</Text>
            <Field label="Email" validationMessage={error ?? undefined}>
              <Input
                type="email"
                value={email}
                onChange={(_, d) => setEmail(d.value)}
                required
                autoFocus
              />
            </Field>
            <Button appearance="primary" type="submit" disabled={busy || !email}>
              Send code
            </Button>
          </form>
        ) : (
          <form className={s.form} onSubmit={verify}>
            <Text>Enter the {OTP_LENGTH}-digit code sent to {email}.</Text>
            <Field label="Code" validationMessage={error ?? undefined}>
              <Input
                inputMode="numeric"
                pattern={OTP_PATTERN}
                value={code}
                onChange={(_, d) => setCode(d.value)}
                required
                autoFocus
              />
            </Field>
            <Button appearance="primary" type="submit" disabled={busy || code.length !== 6}>
              Sign in
            </Button>
            <Button appearance="subtle" onClick={() => setStep("email")} disabled={busy}>
              Use a different email
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
