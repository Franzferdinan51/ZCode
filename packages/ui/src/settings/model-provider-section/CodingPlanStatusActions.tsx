import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function CodingPlanStatusActions({
  isPurchased,
  canDisconnectProvider,
  disconnectLoading,
  onDisconnect,
}: {
  isPurchased: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}
