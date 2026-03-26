import { MicrosoftPresenter, type PresenterEvent } from "../index.js";

function formatRaw(raw: Buffer): string {
  return [...raw].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function logEvent(event: PresenterEvent): void {
  console.log(
    `[${new Date(event.timestamp).toISOString()}] ${event.button}:${event.action} raw=${formatRaw(event.raw)}`
  );
}

async function main(): Promise<void> {
  const presenter = await MicrosoftPresenter.connect({ debug: true });

  console.log(`Listening on ${presenter.device.devicePath}`);

  presenter.on("button", logEvent);
  presenter.on("error", (error: unknown) => {
    console.error("Presenter error:", error);
  });

  const shutdown = async (): Promise<void> => {
    console.log("\nStopping presenter listener...");
    await presenter.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
