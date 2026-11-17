// Near Service Admin — Cities (Phase 4, item 3: multi-city ops).
// NEW FILE ONLY: it does NOT import @/lib/api or @/lib/types (shared
// files owned by the integrator) — it calls the API directly with fetch,
// using the same NEXT_PUBLIC_API_URL base and ns_admin_token localStorage
// key as lib/api.ts. The wiring note in docs/phase4-cities.md lists the
// api.ts/types.ts additions that would let this page use the shared
// client instead.
//
// What it does: list cities with status, open one city to see its gate
// config + latest evaluation, run a new gate evaluation, move the city
// through the lifecycle (planned -> in_preparation -> gate_review ->
// live -> paused), edit supply targets / radius, and tick the launch
// checklist. Status changes and manager assignment are super_admin
// only — the API enforces that server-side and returns 403 otherwise.
"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/components/AdminShell";
import { ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/Badge";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1";

type CityStatus =
  | "planned"
  | "in_preparation"
  | "gate_review"
  | "live"
  | "paused";

interface City {
  id: string;
  name: string;
  slug: string;
  status: CityStatus;
  is_launched: boolean;
  launched_at: string | null;
  default_radius_km: number;
  supply_target_providers: number;
  population_estimate: number | null;
  manager_id: string | null;
}

interface GateEvaluation {
  id: string;
  evaluated_at: string;
  passed: boolean;
  metrics: {
    providerCount: number;
    supplyDensityPer100k: number | null;
    fillRate: number | null;
    timeToFirstOfferSeconds: number | null;
  };
  results: Record<string, { value: number | null; threshold: number; passed: boolean; reason: string | null }>;
}

interface ChecklistItem {
  id: string;
  item_key: string;
  label: string;
  done: boolean;
}

const NEXT_STATUS: Record<CityStatus, CityStatus[]> = {
  planned: ["in_preparation"],
  in_preparation: ["gate_review", "planned"],
  gate_review: ["live", "in_preparation"],
  live: ["paused"],
  paused: ["gate_review"],
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    typeof window === "undefined"
      ? null
      : localStorage.getItem("ns_admin_token");
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: { message?: string } }).error?.message ||
        `Request failed (${res.status})`,
    );
  }
  return data as T;
}

export default function CitiesPage() {
  const [cities, setCities] = useState<City[]>([]);
  const [selected, setSelected] = useState<City | null>(null);
  const [evaluations, setEvaluations] = useState<GateEvaluation[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [radius, setRadius] = useState("");

  const loadCities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCities(await api<City[]>("/admin/cities"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cities");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (city: City) => {
    setSelected(city);
    setTarget(String(city.supply_target_providers));
    setRadius(String(city.default_radius_km));
    try {
      const [evals, list] = await Promise.all([
        api<{ items: GateEvaluation[] }>(`/admin/cities/${city.id}/gate-evaluations`),
        api<{ items: ChecklistItem[] }>(`/admin/cities/${city.id}/checklist`),
      ]);
      setEvaluations(evals.items);
      setChecklist(list.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load city detail");
    }
  }, []);

  useEffect(() => {
    loadCities();
  }, [loadCities]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await loadCities();
      if (selected) await loadDetail(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const latest = evaluations[0];

  return (
    <AdminShell
      title="Cities"
      subtitle="Multi-city ops: a city goes live only when its go/no-go gate passes."
    >
      <p className="text-sm text-gray-500 mb-4">
        City Managers see only their assigned cities; status changes are
        super_admin only.
      </p>
      {loading ? (
        <LoadingState />
      ) : error && cities.length === 0 ? (
        <ErrorState message={error} onRetry={loadCities} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <table className="w-full text-sm border">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">City</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Supply target</th>
                  <th className="p-2">Radius</th>
                </tr>
              </thead>
              <tbody>
                {cities.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b cursor-pointer ${selected?.id === c.id ? "bg-yellow-50" : ""}`}
                    onClick={() => loadDetail(c)}
                  >
                    <td className="p-2 font-medium">{c.name}</td>
                    <td className="p-2">
                      <Badge>{c.status}</Badge>
                    </td>
                    <td className="p-2">{c.supply_target_providers} providers</td>
                    <td className="p-2">{c.default_radius_km} km</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
          </div>

          {selected && (
            <div className="border p-4 space-y-4">
              <h2 className="text-xl font-semibold">{selected.name}</h2>
              <p className="text-sm text-gray-500">
                {selected.is_launched ? "Launched" : "Not launched"}
                {selected.launched_at ? ` · since ${selected.launched_at.slice(0, 10)}` : ""}
                {selected.population_estimate
                  ? ` · pop. ~${selected.population_estimate.toLocaleString()}`
                  : ""}
              </p>

              <div>
                <h3 className="font-semibold mb-1">Go / no-go gate</h3>
                {latest ? (
                  <div className="text-sm space-y-1">
                    <p>
                      Latest evaluation {latest.evaluated_at.slice(0, 19).replace("T", " ")}:{" "}
                      <Badge>{latest.passed ? "PASSED" : "FAILED"}</Badge>
                    </p>
                    <p>Providers: {latest.metrics.providerCount}</p>
                    <p>
                      Supply density:{" "}
                      {latest.metrics.supplyDensityPer100k ?? "no data"} per 100k
                    </p>
                    <p>
                      Fill rate:{" "}
                      {latest.metrics.fillRate != null
                        ? `${(latest.metrics.fillRate * 100).toFixed(0)}%`
                        : "no data"}
                    </p>
                    <p>
                      Time to first offer:{" "}
                      {latest.metrics.timeToFirstOfferSeconds != null
                        ? `${latest.metrics.timeToFirstOfferSeconds}s`
                        : "no data"}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm">No evaluation yet.</p>
                )}
                <button
                  className="mt-2 px-3 py-1 border rounded disabled:opacity-50"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      api(`/admin/cities/${selected.id}/gate-evaluations`, {
                        method: "POST",
                        body: JSON.stringify({}),
                      }).then(() => undefined),
                    )
                  }
                >
                  Run gate evaluation
                </button>
              </div>

              <div>
                <h3 className="font-semibold mb-1">Status</h3>
                <div className="flex gap-2 flex-wrap">
                  {NEXT_STATUS[selected.status].map((to) => (
                    <button
                      key={to}
                      className="px-3 py-1 border rounded disabled:opacity-50"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          api(`/admin/cities/${selected.id}/status`, {
                            method: "POST",
                            body: JSON.stringify({ to }),
                          }).then(() => undefined),
                        )
                      }
                    >
                      → {to}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-1">Supply target &amp; radius</h3>
                <div className="flex gap-2 items-center text-sm">
                  <label>
                    Target{" "}
                    <input
                      className="border rounded px-2 py-1 w-20"
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    Radius (km){" "}
                    <input
                      className="border rounded px-2 py-1 w-20"
                      value={radius}
                      onChange={(e) => setRadius(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                  <button
                    className="px-3 py-1 border rounded disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api(`/admin/cities/${selected.id}/targets`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            supply_target_providers: Number(target),
                            default_radius_km: Number(radius),
                          }),
                        }).then(() => undefined),
                      )
                    }
                  >
                    Save
                  </button>
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-1">Launch checklist</h3>
                <ul className="text-sm space-y-1">
                  {checklist.map((item) => (
                    <li key={item.id} className="flex gap-2 items-center">
                      <input
                        type="checkbox"
                        checked={item.done}
                        disabled={busy}
                        onChange={() =>
                          run(() =>
                            api(
                              `/admin/cities/${selected.id}/checklist/${item.item_key}`,
                              {
                                method: "PATCH",
                                body: JSON.stringify({ done: !item.done }),
                              },
                            ).then(() => undefined),
                          )
                        }
                      />
                      <span className={item.done ? "line-through text-gray-400" : ""}>
                        {item.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </AdminShell>
  );
}
