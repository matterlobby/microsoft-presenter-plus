import { openPresenter, type PresenterEvent } from "../index.js";

function formatRaw(raw: Buffer): string {
  return [...raw].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function logEvent(event: PresenterEvent): void {
  console.log(
    `[${new Date(event.timestamp).toISOString()}] ${event.button}:${event.action} raw=${formatRaw(event.raw)}`
  );
}

async function main(): Promise<void> {
  const devicePath = process.argv[2];

  if (!devicePath) {
    console.error("Usage: npm run example:open-by-path -- /dev/hidrawX");
    process.exit(1);
  }

  const presenter = await openPresenter(devicePath);

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
