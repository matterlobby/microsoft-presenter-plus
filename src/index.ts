import fs from "node:fs";
import {
  discoverMicrosoftPresenter,
  PresenterDiscoveryError,
} from "./hidDiscovery.js";

type PresenterButton = "mic" | "left" | "right" | "light" | "teams";
type PresenterAction = "press" | "release";

interface PresenterEvent {
  button: PresenterButton;
  action: PresenterAction;
  raw: Buffer;
}

type PresenterEventHandler = (event: PresenterEvent) => void;

const BUTTON_MAP: Record<number, PresenterButton> = {
  0x3f: "mic",
  0x3b: "left",
  0x3c: "right",
  0x3d: "light",
  0x3e: "teams",
};

class MicrosoftPresenterRaw {
  private readonly devicePath: string;
  private readonly reportLength: number;
  private fd: number | null = null;
  private running = false;
  private readonly handlers = new Set<PresenterEventHandler>();

  public constructor(devicePath: string, reportLength = 8) {
    this.devicePath = devicePath;
    this.reportLength = reportLength;
  }

  public onEvent(handler: PresenterEventHandler): void {
    this.handlers.add(handler);
  }

  public offEvent(handler: PresenterEventHandler): void {
    this.handlers.delete(handler);
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.fd = fs.openSync(this.devicePath, "r");
    this.running = true;

    this.readLoop().catch((error: unknown) => {
      console.error("Read loop failed:", error);
      this.stop();
      process.exitCode = 1;
    });
  }

  public stop(): void {
    this.running = false;

    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private async readLoop(): Promise<void> {
    if (this.fd === null) {
      throw new Error("Device is not open.");
    }

    while (this.running) {
      const report = Buffer.alloc(this.reportLength);
      const bytesRead = await this.readExactly(this.fd, report, this.reportLength);

      if (bytesRead === 0) {
        continue;
      }

      if (bytesRead !== this.reportLength) {
        console.warn(`Ignoring short report (${bytesRead} bytes):`, report.subarray(0, bytesRead));
        continue;
      }

      const event = this.parseReport(report);

      if (!event) {
        continue;
      }

      for (const handler of this.handlers) {
        try {
          handler(event);
        } catch (error: unknown) {
          console.error("Event handler failed:", error);
        }
      }
    }
  }

  private parseReport(report: Buffer): PresenterEvent | null {
    // We only care about reports like:
    // 04 3f 01 00 00 00 00 00   => mic press
    // 04 3f 00 00 00 00 00 00   => mic release
    //
    // Other report types (for example 01 ... keyboard usage reports)
    // are ignored here on purpose.

    const reportType = report[0];
    if (reportType !== 0x04) {
      return null;
    }

    const buttonCode = report[1];
    const state = report[2];

    const button = BUTTON_MAP[buttonCode];
    if (!button) {
      return null;
    }

    let action: PresenterAction | null = null;

    if (state === 0x01) {
      action = "press";
    } else if (state === 0x00) {
      action = "release";
    }

    if (!action) {
      return null;
    }

    return {
      button,
      action,
      raw: Buffer.from(report),
    };
  }

  private readExactly(fd: number, buffer: Buffer, length: number): Promise<number> {
    return new Promise((resolve, reject) => {
      fs.read(fd, buffer, 0, length, null, (error, bytesRead) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(bytesRead);
      });
    });
  }
}

function formatRaw(buffer: Buffer): string {
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function main(): void {
  const discoveryDebugEnabled = process.env.PRESENTER_DEBUG === "1";
  let discoveredDevicePath: string;

  try {
    const device = discoverMicrosoftPresenter({ debug: discoveryDebugEnabled });
    discoveredDevicePath = device.devicePath;

    if (discoveryDebugEnabled) {
      console.error(
        `[Discovery] Opening ${device.devicePath} for Microsoft Presenter+ input.`
      );
    }
  } catch (error: unknown) {
    if (error instanceof PresenterDiscoveryError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }

  const presenter = new MicrosoftPresenterRaw(discoveredDevicePath);

  presenter.onEvent((event) => {
    console.log(
      `[Presenter] ${event.button}_${event.action} | raw=${formatRaw(event.raw)}`
    );

    // Example mapping:
    if (event.button === "mic" && event.action === "press") {
      console.log("TODO: Activate WING talkback");
    }

    if (event.button === "mic" && event.action === "release") {
      console.log("TODO: Deactivate WING talkback");
    }

    if (event.button === "left" && event.action === "press") {
      console.log("TODO: Previous cue");
    }

    if (event.button === "right" && event.action === "press") {
      console.log("TODO: Next cue");
    }

    if (event.button === "light" && event.action === "press") {
      console.log("TODO: Trigger light function");
    }

    if (event.button === "teams" && event.action === "press") {
      console.log("TODO: Trigger teams function");
    }
  });

  process.on("SIGINT", () => {
    console.log("\nStopping presenter reader...");
    presenter.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    presenter.stop();
    process.exit(0);
  });

  presenter.start();
}

main();
