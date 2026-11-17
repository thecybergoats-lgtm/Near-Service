"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearAuth, getStoredUser } from "@/lib/api";
import type { AuthUser } from "@/lib/types";

export const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  verification_officer: "Verification Officer",
  support_agent: "Support Agent",
  finance: "Finance",
  marketing: "Marketing",
  city_manager: "City Manager",
};

export default function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    setUser(getStoredUser());
  }, []);

  function logout() {
    clearAuth();
    router.push("/login");
  }

  return (
    <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        {user && (
          <div className="text-right">
            <div className="text-sm font-semibold text-slate-800">{user.full_name || user.phone}</div>
            <div className="text-xs text-slate-500">
              {ROLE_LABELS[user.role] || user.role} · {user.phone}
            </div>
          </div>
        )}
        <button
          onClick={logout}
          className="text-sm font-medium text-brand-700 border border-brand-600 rounded-lg px-3 py-1.5 hover:bg-brand-50"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
