import { useQuery } from "@tanstack/react-query";
import { api, type IntegrationHealth } from "@/lib/api";

const LABEL: Record<IntegrationHealth, string> = {
  LIVE: "Live",
  NOT_CONFIGURED: "Not configured",
  ERROR: "Error",
  MOCK: "Mock / test only",
  UNVERIFIED: "Not verified",
};

function tone(status: IntegrationHealth): string {
  if (status === "LIVE") return "bg-lime text-lime-foreground";
  if (status === "ERROR") return "bg-primary text-primary-foreground";
  if (status === "MOCK") return "bg-ink text-ink-foreground";
  return "bg-background text-foreground";
}

export function IntegrationStatus() {
  const query = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.integrations(),
    retry: false,
    staleTime: 60_000,
  });

  // Only show statuses from a real live check; the sponsor cards below cover the rest.
  if (!query.data?.checkedAt || query.data.integrations.length === 0) return null;

  const checked = `Last live check ${new Date(query.data.checkedAt).toLocaleString()}`;

  return (
    <div className="mt-6">
      <p className="text-sm text-muted-foreground">{checked}</p>
      <ul className="mt-3 grid sm:grid-cols-2 gap-2">
        {query.data.integrations.map((item) => (
          <li key={item.id} className="bg-card outline-card rounded-2xl p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-bold">{item.label}</span>
              <span
                className={`text-[11px] font-bold uppercase tracking-wider rounded-full px-2 py-1 outline-card ${tone(item.status)}`}
              >
                {LABEL[item.status] ?? item.status}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
