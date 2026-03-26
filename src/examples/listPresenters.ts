import { listPresenters } from "../index.js";

async function main(): Promise<void> {
  const devices = await listPresenters({ debug: true });

  if (devices.length === 0) {
    console.log("No Microsoft Presenter+ devices found.");
    return;
  }

  for (const device of devices) {
    console.log(JSON.stringify(device, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
