import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Dashboard", icon: "▦" },
  { href: "/verifications", label: "Verifications", icon: "✓" },
  { href: "/users", label: "Users & Providers", icon: "👥" },
  { href: "/categories", label: "Catalog / Categories", icon: "🗂" },
  { href: "/requests", label: "Requests", icon: "📋" },
  { href: "/jobs", label: "Jobs", icon: "🔧" },
  { href: "/disputes", label: "Disputes", icon: "⚖" },
  { href: "/risk", label: "Risk Review", icon: "🛡" },
  { href: "/analytics", label: "Analytics", icon: "📊" },
  { href: "/cities", label: "Cities", icon: "🏙" },
  { href: "/partners", label: "Partners", icon: "🧰" },
  { href: "/warranty", label: "Warranty", icon: "🎖" },
  { href: "/search-metrics", label: "Search Metrics", icon: "🔍" },
  { href: "/subscriptions", label: "Subscriptions", icon: "★" },
  { href: "/finance", label: "Finance — Escrow", icon: "₨" },
  { href: "/commission", label: "Commission", icon: "₨" },
  { href: "/promos", label: "Promos", icon: "🎟" },
  { href: "/audit-logs", label: "Audit Log", icon: "📜" },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 w-60 bg-brand-900 text-white flex flex-col">
      <div className="px-5 py-5 border-b border-white/10">
        <div className="text-xl font-bold tracking-tight">Near Service</div>
        <div className="text-xs text-teal-200/80 mt-0.5">Admin Panel · Quetta pilot</div>
      </div>
      <nav className="flex-1 py-4 px-3 space-y-1">
        {NAV.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active ? "bg-white/15 text-white" : "text-teal-100/80 hover:bg-white/10 hover:text-white"
              }`}
            >
              <span className="w-5 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 border-t border-white/10 text-xs text-teal-200/70">
        Phase 1 MVP · Cash-only
        <br />
        API: {process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1"}
      </div>
    </aside>
  );
}
