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
  if (status === "MOCK") return "bg-foreground text-background";
  return "bg-background text-foreground";
}

export function IntegrationStatus() {
  const query = useQuery({
    queryKey: ["integrations"],
    queryFn: () => api.integrations(),
    retry: false,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return <p className="mt-4 text-sm text-muted-foreground">Checking integration status…</p>;
  }
  if (query.isError || !query.data) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Live status is unavailable until the agent API is running. Nothing here is marked connected
        by default.
      </p>
    );
  }

  const checked = query.data.checkedAt
    ? `Last live check ${new Date(query.data.checkedAt).toLocaleString()}`
    : "No live check has been recorded yet. Credentials alone are not shown as live.";

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
