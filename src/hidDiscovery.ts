import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PRESENTER_VENDOR_ID = "045e";
const PRESENTER_PRODUCT_ID = "0851";
const PRESENTER_NAME_FRAGMENT = "presenter+";
const HIDRAW_PREFIX = "hidraw";

export interface HidrawDeviceInfo {
  devicePath: string;
  vendorId: string | null;
  productId: string | null;
  hidName: string | null;
  udevProperties: Record<string, string>;
}

interface CandidateEvaluation {
  device: HidrawDeviceInfo;
  rejectionReasons: string[];
  supportiveSignals: string[];
}

export class PresenterDiscoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PresenterDiscoveryError";
  }
}

export function listMicrosoftPresenters(options?: {
  debug?: boolean;
}): HidrawDeviceInfo[] {
  const debug = options?.debug ?? false;
  const devicePaths = enumerateHidrawDevicePaths();

  if (debug) {
    console.error(`[Discovery] Found ${devicePaths.length} hidraw device(s).`);
  }

  const evaluations = devicePaths.map((devicePath) => evaluateDevice(devicePath, debug));
  return evaluations
    .filter((evaluation) => evaluation.rejectionReasons.length === 0)
    .map((evaluation) => evaluation.device);
}

export function discoverMicrosoftPresenter(options?: {
  debug?: boolean;
}): HidrawDeviceInfo {
  const debug = options?.debug ?? false;
  const devicePaths = enumerateHidrawDevicePaths();

  if (debug) {
    console.error(`[Discovery] Found ${devicePaths.length} hidraw device(s).`);
  }

  const evaluations = devicePaths.map((devicePath) => evaluateDevice(devicePath, debug));
  const matches = evaluations.filter((evaluation) => evaluation.rejectionReasons.length === 0);

  if (matches.length === 1) {
    const match = matches[0];

    if (debug) {
      const signals =
        match.supportiveSignals.length > 0 ? ` (${match.supportiveSignals.join(", ")})` : "";
      console.error(`[Discovery] Selected ${match.device.devicePath}${signals}.`);
    }

    return match.device;
  }

  if (matches.length === 0) {
    const diagnostics =
      evaluations.length > 0
        ? evaluations
            .map(
              (evaluation) =>
                `- ${evaluation.device.devicePath}: ${formatDeviceSummary(evaluation.device)}; rejected: ${evaluation.rejectionReasons.join("; ")}`
            )
            .join("\n")
        : "- No /dev/hidraw* devices were found.";

    throw new PresenterDiscoveryError(
      [
        "Could not find a connected Microsoft Presenter+ hidraw device.",
        `Expected vendor ID ${PRESENTER_VENDOR_ID.toUpperCase()} and product ID ${PRESENTER_PRODUCT_ID.toUpperCase()}.`,
        "Scanned devices:",
        diagnostics,
        "Make sure the presenter is connected and that this process has permission to read the hidraw device.",
      ].join("\n")
    );
  }

  const ambiguityDetails = matches
    .map(
      (evaluation) =>
        `- ${evaluation.device.devicePath}: ${formatDeviceSummary(evaluation.device)}`
    )
    .join("\n");

  throw new PresenterDiscoveryError(
    [
      "Multiple Microsoft Presenter+ hidraw devices matched the discovery criteria.",
      "Scanned matches:",
      ambiguityDetails,
      "Disconnect extra devices or refine the discovery criteria before starting the application.",
    ].join("\n")
  );
}

function enumerateHidrawDevicePaths(): string[] {
  let entries: string[];

  try {
    entries = fs.readdirSync("/dev", { withFileTypes: true }).map((entry) => entry.name);
  } catch (error: unknown) {
    throw new PresenterDiscoveryError(
      `Failed to enumerate hidraw devices under /dev: ${formatError(error)}`
    );
  }

  return entries
    .filter((entry) => entry.startsWith(HIDRAW_PREFIX))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((entry) => path.join("/dev", entry));
}

function evaluateDevice(devicePath: string, debug: boolean): CandidateEvaluation {
  const device = readHidrawDeviceInfo(devicePath);
  const rejectionReasons: string[] = [];
  const supportiveSignals: string[] = [];

  if (device.vendorId !== PRESENTER_VENDOR_ID) {
    rejectionReasons.push(
      `vendor ID ${device.vendorId?.toUpperCase() ?? "unknown"} does not match ${PRESENTER_VENDOR_ID.toUpperCase()}`
    );
  }

  if (device.productId !== PRESENTER_PRODUCT_ID) {
    rejectionReasons.push(
      `product ID ${device.productId?.toUpperCase() ?? "unknown"} does not match ${PRESENTER_PRODUCT_ID.toUpperCase()}`
    );
  }

  if (device.hidName && normalizeForComparison(device.hidName).includes(PRESENTER_NAME_FRAGMENT)) {
    supportiveSignals.push(`name=${JSON.stringify(device.hidName)}`);
  } else if (device.hidName) {
    supportiveSignals.push(`name mismatch=${JSON.stringify(device.hidName)}`);
  } else {
    supportiveSignals.push("name unavailable");
  }

  if (debug) {
    const verdict =
      rejectionReasons.length === 0
        ? "candidate accepted"
        : `rejected: ${rejectionReasons.join("; ")}`;
    console.error(`[Discovery] ${devicePath}: ${formatDeviceSummary(device)}; ${verdict}`);
  }

  return {
    device,
    rejectionReasons,
    supportiveSignals,
  };
}

function readHidrawDeviceInfo(devicePath: string): HidrawDeviceInfo {
  const udevProperties = readUdevProperties(devicePath);
  const sysfsProperties = readSysfsProperties(devicePath);

  const vendorId = normalizeHexIdentifier(
    udevProperties.ID_VENDOR_ID ??
      extractHidIdPart(udevProperties.HID_ID, 1) ??
      sysfsProperties.vendorId
  );
  const productId = normalizeHexIdentifier(
    udevProperties.ID_MODEL_ID ??
      extractHidIdPart(udevProperties.HID_ID, 2) ??
      sysfsProperties.productId
  );
  const hidName =
    firstNonEmpty(
      udevProperties.HID_NAME,
      udevProperties.ID_MODEL_FROM_DATABASE,
      udevProperties.ID_MODEL_ENC,
      sysfsProperties.hidName
    ) ?? null;

  return {
    devicePath,
    vendorId,
    productId,
    hidName,
    udevProperties,
  };
}

function readUdevProperties(devicePath: string): Record<string, string> {
  try {
    const output = execFileSync(
      "udevadm",
      ["info", "--query=property", `--name=${devicePath}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );

    return parseKeyValueLines(output);
  } catch {
    return {};
  }
}

function readSysfsProperties(devicePath: string): {
  vendorId: string | null;
  productId: string | null;
  hidName: string | null;
} {
  const hidrawName = path.basename(devicePath);
  const classDevicePath = path.join("/sys/class/hidraw", hidrawName);

  let resolvedDevicePath: string | null = null;

  try {
    resolvedDevicePath = fs.realpathSync(path.join(classDevicePath, "device"));
  } catch {
    return {
      vendorId: null,
      productId: null,
      hidName: null,
    };
  }

  const ueventProperties = parseKeyValueLines(
    safeReadFile(path.join(resolvedDevicePath, "uevent")) ?? ""
  );
  const deviceIdentifierParts = parseHidIdentifier(
    ueventProperties.HID_ID ?? path.basename(resolvedDevicePath)
  );
  const modaliasIdentifierParts = parseHidModalias(
    readFirstLine(path.join(resolvedDevicePath, "modalias"))
  );

  let vendorId =
    deviceIdentifierParts?.vendorId ??
    normalizeHexIdentifier(ueventProperties.HID_VENDOR) ??
    normalizeHexIdentifier(ueventProperties.VENDOR_ID) ??
    modaliasIdentifierParts?.vendorId ??
    normalizeHexIdentifier(readFirstLine(path.join(resolvedDevicePath, "idVendor")));
  let productId =
    deviceIdentifierParts?.productId ??
    normalizeHexIdentifier(ueventProperties.HID_PRODUCT) ??
    normalizeHexIdentifier(ueventProperties.PRODUCT_ID) ??
    modaliasIdentifierParts?.productId ??
    normalizeHexIdentifier(readFirstLine(path.join(resolvedDevicePath, "idProduct")));

  if (!vendorId || !productId) {
    const hidUevent = findNearestHidUevent(resolvedDevicePath);
    if (hidUevent) {
      vendorId ??= normalizeHexIdentifier(hidUevent.HID_VENDOR);
      productId ??= normalizeHexIdentifier(hidUevent.HID_PRODUCT);
    }
  }

  const hidName =
    firstNonEmpty(
      ueventProperties.HID_NAME,
      readFirstLine(path.join(resolvedDevicePath, "name")),
      findNearestHidUevent(resolvedDevicePath)?.HID_NAME ?? null
    ) ?? null;

  return {
    vendorId,
    productId,
    hidName,
  };
}

function findNearestHidUevent(startPath: string): Record<string, string> | null {
  let currentPath = startPath;

  for (let depth = 0; depth < 6; depth += 1) {
    const ueventPath = path.join(currentPath, "uevent");
    const properties = parseKeyValueLines(safeReadFile(ueventPath) ?? "");

    if (properties.HID_ID || properties.HID_NAME || properties.HID_VENDOR || properties.HID_PRODUCT) {
      return properties;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return null;
}

function parseKeyValueLines(input: string): Record<string, string> {
  const properties: Record<string, string> = {};

  for (const line of input.split(/\r?\n/u)) {
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    properties[key] = value;
  }

  return properties;
}

function extractHidIdPart(hidId: string | undefined, index: number): string | null {
  if (!hidId) {
    return null;
  }

  const parts = hidId.split(":");
  return parts[index] ? normalizeHexIdentifier(parts[index]) : null;
}

function normalizeHexIdentifier(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const withoutPrefix = value.trim().toLowerCase().replace(/^0x/u, "");

  if (!/^[0-9a-f]+$/u.test(withoutPrefix)) {
    return null;
  }

  const normalized = withoutPrefix.replace(/^0+/u, "") || "0";

  return normalized.padStart(4, "0");
}

function parseHidIdentifier(identifier: string | null | undefined): {
  vendorId: string;
  productId: string;
} | null {
  if (!identifier) {
    return null;
  }

  const match = identifier.trim().match(/^[0-9a-fA-F]+:([0-9a-fA-F]+):([0-9a-fA-F]+)(?:\.[0-9a-fA-F]+)?$/u);
  if (!match) {
    return null;
  }

  const vendorId = normalizeHexIdentifier(match[1]);
  const productId = normalizeHexIdentifier(match[2]);

  if (!vendorId || !productId) {
    return null;
  }

  return { vendorId, productId };
}

function parseHidModalias(modalias: string | null | undefined): {
  vendorId: string;
  productId: string;
} | null {
  if (!modalias) {
    return null;
  }

  const match = modalias.trim().match(/v([0-9a-fA-F]+)p([0-9a-fA-F]+)/u);
  if (!match) {
    return null;
  }

  const vendorId = normalizeHexIdentifier(match[1]);
  const productId = normalizeHexIdentifier(match[2]);

  if (!vendorId || !productId) {
    return null;
  }

  return { vendorId, productId };
}

function normalizeForComparison(value: string): string {
  return value.trim().toLowerCase();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readFirstLine(filePath: string): string | null {
  const content = safeReadFile(filePath);

  if (!content) {
    return null;
  }

  const [firstLine] = content.split(/\r?\n/u);
  return firstLine?.trim() || null;
}

function formatDeviceSummary(device: HidrawDeviceInfo): string {
  return [
    `vendor=${device.vendorId?.toUpperCase() ?? "unknown"}`,
    `product=${device.productId?.toUpperCase() ?? "unknown"}`,
    `name=${JSON.stringify(device.hidName ?? "unknown")}`,
  ].join(", ");
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
