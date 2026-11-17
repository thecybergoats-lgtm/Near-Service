"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, requestOtp, storeAuth, verifyOtp } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("+923001111111");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await requestOtp(phone);
      setDevOtp(res.dev_otp || null);
      setStep("otp");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the API. Is the backend running?");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await verifyOtp(phone, otp);
      storeAuth(res.token, res.user);
      router.push("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-900 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-2xl font-bold text-slate-900">Near Service</div>
        <p className="text-sm text-slate-500 mt-1">Admin Panel · sign in with phone OTP</p>

        {step === "phone" ? (
          <form onSubmit={handleRequestOtp} className="mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Admin phone number</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-600"
                placeholder="+923001111111"
                required
              />
            </label>
            <p className="text-xs text-slate-500">
              Dev admin account: <strong>+923001111111</strong> (dev OTP in the backend logs / response).
            </p>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-brand-700 text-white font-semibold rounded-lg py-2.5 hover:bg-brand-800 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send OTP"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">OTP sent to {phone}</span>
              <input
                type="text"
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-900 tracking-widest text-lg focus:outline-none focus:ring-2 focus:ring-brand-600"
                placeholder="6-digit code"
                required
              />
            </label>
            {devOtp && (
              <p className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2">
                Dev mode: the backend returned OTP <strong>{devOtp}</strong>. (Never shown in production.)
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-brand-700 text-white font-semibold rounded-lg py-2.5 hover:bg-brand-800 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>
            <button
              type="button"
              onClick={() => setStep("phone")}
              className="w-full text-sm text-brand-700 font-medium py-1"
            >
              Change phone number
            </button>
          </form>
        )}

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <p className="text-xs text-slate-400 mt-6">
          JWT is stored in localStorage for this Phase 1 MVP. Move to httpOnly cookies + refresh-token
          rotation before production (PRD §14).
        </p>
      </div>
    </div>
  );
}
