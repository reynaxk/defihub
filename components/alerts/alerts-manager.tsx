"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const ALERT_TYPES = [
  { value: "protocol_tvl", label: "Protocol TVL", hint: "Protocol slug, e.g. aave-v3 (from its page URL)" },
  { value: "chain_tvl", label: "Chain TVL", hint: "Chain slug, e.g. ethereum (from its page URL)" },
  { value: "token_price", label: "Token price", hint: "CoinGecko id, e.g. ethereum, solana, binancecoin" },
  { value: "pool_apy", label: "Pool APY", hint: "Yield pool id (from the Yields page)" },
] as const;

const CONDITIONS = [
  { value: "above", label: "Rises above" },
  { value: "below", label: "Falls below" },
  { value: "percent_change_up", label: "Increases by (%) since last check" },
  { value: "percent_change_down", label: "Decreases by (%) since last check" },
] as const;

const createAlertSchema = z.object({
  type: z.enum(["protocol_tvl", "chain_tvl", "token_price", "pool_apy"]),
  target: z.string().min(1, "Required"),
  condition: z.enum(["above", "below", "percent_change_up", "percent_change_down"]),
  threshold: z
    .string()
    .min(1, "Required")
    .refine((v) => Number.isFinite(Number(v)), "Must be a number"),
});

type CreateAlertForm = z.infer<typeof createAlertSchema>;

export interface AlertRow {
  id: string;
  type: string;
  target: string;
  condition: string;
  threshold: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
}

export function AlertsManager({ initialAlerts }: { initialAlerts: AlertRow[] }) {
  const [alertsList, setAlertsList] = useState(initialAlerts);
  const {
    control,
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateAlertForm>({
    resolver: zodResolver(createAlertSchema),
    defaultValues: { type: "protocol_tvl", condition: "above" },
  });

  const selectedType = watch("type");
  const hint = ALERT_TYPES.find((t) => t.value === selectedType)?.hint;

  async function onCreate(values: CreateAlertForm) {
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...values, threshold: Number(values.threshold) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Couldn't create alert");
      return;
    }
    const { alert } = await res.json();
    setAlertsList((prev) => [alert, ...prev]);
    reset({ type: values.type, condition: "above", target: "", threshold: "" });
    toast.success("Alert created");
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    const res = await fetch(`/api/alerts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      toast.error("Couldn't update alert");
      return;
    }
    setAlertsList((prev) => prev.map((a) => (a.id === id ? { ...a, enabled } : a)));
  }

  async function deleteAlert(id: string) {
    const res = await fetch(`/api/alerts/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Couldn't delete alert");
      return;
    }
    setAlertsList((prev) => prev.filter((a) => a.id !== id));
    toast.success("Alert deleted");
  }

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New alert</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onCreate)} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label>Type</Label>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALERT_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
              <Label htmlFor="target">Target</Label>
              <Input id="target" {...register("target")} placeholder={hint} />
              {errors.target && <p className="text-sm text-destructive">{errors.target.message}</p>}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Condition</Label>
              <Controller
                control={control}
                name="condition"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONDITIONS.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="threshold">Threshold</Label>
              <Input id="threshold" type="number" step="any" {...register("threshold")} />
              {errors.threshold && <p className="text-sm text-destructive">{errors.threshold.message}</p>}
            </div>

            <div className="flex items-end sm:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create alert"}
              </Button>
            </div>
          </form>
          {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead className="text-right">Threshold</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Last triggered</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {alertsList.map((alert) => (
              <TableRow key={alert.id}>
                <TableCell>{ALERT_TYPES.find((t) => t.value === alert.type)?.label ?? alert.type}</TableCell>
                <TableCell className="font-medium">{alert.target}</TableCell>
                <TableCell className="text-muted-foreground">
                  {CONDITIONS.find((c) => c.value === alert.condition)?.label ?? alert.condition}
                </TableCell>
                <TableCell className="text-right tabular-nums">{alert.threshold}</TableCell>
                <TableCell>
                  <Switch checked={alert.enabled} onCheckedChange={(checked) => toggleEnabled(alert.id, checked)} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {alert.lastTriggeredAt ? new Date(alert.lastTriggeredAt).toLocaleString() : "Never"}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => deleteAlert(alert.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {alertsList.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No alerts yet — create one above.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
