import { EventEmitter } from "node:events";
import fs from "node:fs";
import {
  discoverMicrosoftPresenter,
  listMicrosoftPresenters,
  PresenterDiscoveryError,
  type HidrawDeviceInfo,
} from "./hidDiscovery.js";

export type PresenterButton = "mic" | "left" | "right" | "light" | "teams";
export type PresenterAction = "press" | "release";
export type PresenterPlatform = "linux";

export interface PresenterDeviceInfo extends HidrawDeviceInfo {
  platform: PresenterPlatform;
}

export interface PresenterEvent {
  button: PresenterButton;
  action: PresenterAction;
  raw: Buffer;
  timestamp: number;
}

export interface DiscoverPresenterOptions {
  debug?: boolean;
}

export interface ConnectPresenterOptions extends DiscoverPresenterOptions {
  devicePath?: string;
  reportLength?: number;
}

export class PresenterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PresenterError";
  }
}

export class PresenterUnsupportedPlatformError extends PresenterError {
  public constructor(platform = process.platform) {
    super(
      `microsoft-presenter-plus currently supports Linux only. Received platform ${JSON.stringify(platform)}.`
    );
    this.name = "PresenterUnsupportedPlatformError";
  }
}

const BUTTON_MAP: Record<number, PresenterButton> = {
  0x3f: "mic",
  0x3b: "left",
  0x3c: "right",
  0x3d: "light",
  0x3e: "teams",
};
const READ_POLL_INTERVAL_MS = 25;

function ensureSupportedPlatform(): void {
  if (process.platform !== "linux") {
    throw new PresenterUnsupportedPlatformError();
  }
}

function toPresenterDeviceInfo(device: HidrawDeviceInfo): PresenterDeviceInfo {
  return {
    ...device,
    platform: "linux",
  };
}

export async function listPresenters(
  options?: DiscoverPresenterOptions
): Promise<PresenterDeviceInfo[]> {
  ensureSupportedPlatform();
  return listMicrosoftPresenters(options).map(toPresenterDeviceInfo);
}

export async function discoverPresenter(
  options?: DiscoverPresenterOptions
): Promise<PresenterDeviceInfo> {
  ensureSupportedPlatform();
  return toPresenterDeviceInfo(discoverMicrosoftPresenter(options));
}

export async function openPresenter(
  devicePath: string,
  options?: Omit<ConnectPresenterOptions, "devicePath">
): Promise<MicrosoftPresenter> {
  const presenter = new MicrosoftPresenter({
    devicePath,
    reportLength: options?.reportLength,
  });

  await presenter.start();
  return presenter;
}

export class MicrosoftPresenter extends EventEmitter {
  public readonly device: PresenterDeviceInfo;
  private readonly reportLength: number;
  private fd: number | null = null;
  private running = false;
  private readLoopPromise: Promise<void> | null = null;

  public constructor(options: { devicePath: string; reportLength?: number }) {
    super();
    ensureSupportedPlatform();

    this.device = {
      devicePath: options.devicePath,
      vendorId: null,
      productId: null,
      hidName: null,
      udevProperties: {},
      platform: "linux",
    };
    this.reportLength = options.reportLength ?? 8;
  }

  public static async connect(
    options?: ConnectPresenterOptions
  ): Promise<MicrosoftPresenter> {
    const device = options?.devicePath
      ? {
          devicePath: options.devicePath,
          vendorId: null,
          productId: null,
          hidName: null,
          udevProperties: {},
          platform: "linux" as const,
        }
      : await discoverPresenter({ debug: options?.debug });

    const presenter = new MicrosoftPresenter({
      devicePath: device.devicePath,
      reportLength: options?.reportLength,
    });
    presenter.device.vendorId = device.vendorId;
    presenter.device.productId = device.productId;
    presenter.device.hidName = device.hidName;
    presenter.device.udevProperties = device.udevProperties;

    await presenter.start();
    return presenter;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      this.fd = fs.openSync(
        this.device.devicePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
      );
    } catch (error: unknown) {
      throw new PresenterError(
        `Failed to open presenter device ${JSON.stringify(this.device.devicePath)}: ${formatError(error)}`
      );
    }

    this.running = true;
    this.readLoopPromise = this.readLoop().catch((error: unknown) => {
      this.running = false;
      this.emit("error", error);
      this.closeFileDescriptor();
    });
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.closeFileDescriptor();

    try {
      await this.readLoopPromise;
    } catch {
      // Read loop errors are surfaced via the "error" event.
    } finally {
      this.readLoopPromise = null;
    }
  }

  public override on(
    eventName: "button" | "error",
    listener: ((event: PresenterEvent) => void) | ((error: unknown) => void)
  ): this {
    return super.on(eventName, listener);
  }

  public override once(
    eventName: "button" | "error",
    listener: ((event: PresenterEvent) => void) | ((error: unknown) => void)
  ): this {
    return super.once(eventName, listener);
  }

  public override off(
    eventName: "button" | "error",
    listener: ((event: PresenterEvent) => void) | ((error: unknown) => void)
  ): this {
    return super.off(eventName, listener);
  }

  private async readLoop(): Promise<void> {
    while (this.running && this.fd !== null) {
      const report = Buffer.alloc(this.reportLength);
      const bytesRead = await this.readExactly(this.fd, report, this.reportLength);

      if (!this.running) {
        break;
      }

      if (bytesRead === 0) {
        await delay(READ_POLL_INTERVAL_MS);
        continue;
      }

      if (bytesRead !== this.reportLength) {
        continue;
      }

      const event = this.parseReport(report);
      if (!event) {
        continue;
      }

      this.emit("button", event);
    }
  }

  private parseReport(report: Buffer): PresenterEvent | null {
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

    const action =
      state === 0x01 ? "press" : state === 0x00 ? "release" : null;

    if (!action) {
      return null;
    }

    return {
      button,
      action,
      raw: Buffer.from(report),
      timestamp: Date.now(),
    };
  }

  private readExactly(fd: number, buffer: Buffer, length: number): Promise<number> {
    return new Promise((resolve, reject) => {
      fs.read(fd, buffer, 0, length, null, (error, bytesRead) => {
        if (error) {
          if (!this.running) {
            resolve(0);
            return;
          }

          if (isWouldBlockError(error)) {
            resolve(0);
            return;
          }

          reject(
            new PresenterError(
              `Failed to read from presenter device ${JSON.stringify(this.device.devicePath)}: ${formatError(error)}`
            )
          );
          return;
        }

        resolve(bytesRead);
      });
    });
  }

  private closeFileDescriptor(): void {
    if (this.fd === null) {
      return;
    }

    try {
      fs.closeSync(this.fd);
    } catch {
      // Ignore close errors during shutdown.
    } finally {
      this.fd = null;
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function isWouldBlockError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export { PresenterDiscoveryError };
