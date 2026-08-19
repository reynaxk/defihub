import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface EndpointParam {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

export function EndpointDoc({
  method,
  path,
  description,
  params,
  exampleResponse,
}: {
  method: "GET";
  path: string;
  description: string;
  params?: EndpointParam[];
  exampleResponse: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Badge className="bg-[var(--success-text)]/15 text-[var(--success-text)]">{method}</Badge>
        <code className="text-sm font-medium">{path}</code>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>

      {params && params.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Param</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {params.map((p) => (
                <TableRow key={p.name}>
                  <TableCell className="font-mono text-xs">
                    {p.name}
                    {p.required && <span className="ml-1 text-destructive">*</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.type}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">Example response</div>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          <code>{exampleResponse}</code>
        </pre>
      </div>
    </Card>
  );
}
