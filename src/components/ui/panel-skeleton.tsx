import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// What a panel looks like while its data is on the way: the same Card chrome
// as the real panel, so the layout does not jump when the data lands. The
// loading stories render this, and `src/app/dashboard/loading.tsx` composes
// it for the whole page, so the story and the page cannot drift apart.
export function PanelSkeleton({
  lines = 3,
  label = "Loading panel",
}: {
  lines?: number;
  label?: string;
}) {
  return (
    <Card data-testid="panel-skeleton" role="status" aria-label={label} aria-busy="true">
      <CardHeader>
        <Skeleton className="h-4 w-32" />
      </CardHeader>
      <CardContent className="flex flex-col gap-tight">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
