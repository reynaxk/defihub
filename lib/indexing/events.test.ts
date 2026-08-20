import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeChunks } from "./events";

describe("computeChunks", () => {
  it("splits an exact multiple of chunkSize into equal chunks", () => {
    expect(computeChunks(BigInt(0), BigInt(5999), BigInt(2000))).toEqual([
      [BigInt(0), BigInt(1999)],
      [BigInt(2000), BigInt(3999)],
      [BigInt(4000), BigInt(5999)],
    ]);
  });

  it("caps the final chunk at toBlock when the range doesn't divide evenly", () => {
    expect(computeChunks(BigInt(0), BigInt(4500), BigInt(2000))).toEqual([
      [BigInt(0), BigInt(1999)],
      [BigInt(2000), BigInt(3999)],
      [BigInt(4000), BigInt(4500)],
    ]);
  });

  it("returns a single chunk when the range fits within chunkSize", () => {
    expect(computeChunks(BigInt(100), BigInt(150), BigInt(2000))).toEqual([[BigInt(100), BigInt(150)]]);
  });

  it("returns a single-block chunk when fromBlock equals toBlock", () => {
    expect(computeChunks(BigInt(42), BigInt(42), BigInt(2000))).toEqual([[BigInt(42), BigInt(42)]]);
  });

  it("returns no chunks when fromBlock is after toBlock", () => {
    expect(computeChunks(BigInt(100), BigInt(50), BigInt(2000))).toEqual([]);
  });

  it("throws for a non-positive chunkSize", () => {
    expect(() => computeChunks(BigInt(0), BigInt(100), BigInt(0))).toThrow();
  });
});

const mockGetLogs = vi.fn();
vi.mock("@/lib/chains/rpc-resilient-client", () => ({
  withResilientClient: (_chainSlug: string, fn: (client: { getLogs: typeof mockGetLogs }) => unknown) =>
    fn({ getLogs: mockGetLogs }),
}));

const mockGetIndexingState = vi.fn();
const mockUpdateIndexingState = vi.fn();
vi.mock("./state", () => ({
  getIndexingState: (...args: unknown[]) => mockGetIndexingState(...args),
  updateIndexingState: (...args: unknown[]) => mockUpdateIndexingState(...args),
}));

const { scanFromCursor } = await import("./events");

const SWAP_EVENT = "event Swap(address indexed sender, uint256 amount)";

describe("scanFromCursor", () => {
  beforeEach(() => {
    mockGetLogs.mockReset();
    mockGetIndexingState.mockReset();
    mockUpdateIndexingState.mockReset().mockResolvedValue(undefined);
  });

  it("uses startBlock when no cursor exists yet, then persists the new cursor", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([{ transactionHash: "0xabc", logIndex: 0 }]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(100),
      startBlock: BigInt(50),
      onLogs,
    });

    expect(result).toEqual({ scannedFrom: BigInt(50), scannedTo: BigInt(100), logCount: 1 });
    expect(onLogs).toHaveBeenCalledWith([{ transactionHash: "0xabc", logIndex: 0 }]);
    expect(mockUpdateIndexingState).toHaveBeenLastCalledWith(
      "ethereum",
      "test-component",
      expect.objectContaining({ status: "idle", lastProcessedBlock: BigInt(100) }),
    );
  });

  it("resumes from lastProcessedBlock + 1 when a cursor already exists", async () => {
    mockGetIndexingState.mockResolvedValue({ lastProcessedBlock: BigInt(200) });
    mockGetLogs.mockResolvedValue([]);
    const onLogs = vi.fn().mockResolvedValue(undefined);

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(300),
      startBlock: BigInt(0),
      onLogs,
    });

    expect(result.scannedFrom).toBe(BigInt(201));
    expect(result.scannedTo).toBe(BigInt(300));
  });

  it("does nothing and reports zero logs when already caught up to currentBlock", async () => {
    mockGetIndexingState.mockResolvedValue({ lastProcessedBlock: BigInt(500) });
    const onLogs = vi.fn();

    const result = await scanFromCursor({
      chainSlug: "ethereum",
      component: "test-component",
      address: "0xpool",
      eventSignature: SWAP_EVENT,
      currentBlock: BigInt(500),
      startBlock: BigInt(0),
      onLogs,
    });

    expect(result.logCount).toBe(0);
    expect(onLogs).not.toHaveBeenCalled();
    expect(mockGetLogs).not.toHaveBeenCalled();
  });

  it("marks the state as error and does not advance the cursor when onLogs throws", async () => {
    mockGetIndexingState.mockResolvedValue(null);
    mockGetLogs.mockResolvedValue([{ transactionHash: "0xabc", logIndex: 0 }]);
    const onLogs = vi.fn().mockRejectedValue(new Error("db write failed"));

    await expect(
      scanFromCursor({
        chainSlug: "ethereum",
        component: "test-component",
        address: "0xpool",
        eventSignature: SWAP_EVENT,
        currentBlock: BigInt(100),
        startBlock: BigInt(50),
        onLogs,
      }),
    ).rejects.toThrow("db write failed");

    const lastCall = mockUpdateIndexingState.mock.calls.at(-1);
    expect(lastCall?.[2]).toMatchObject({ status: "error", error: "db write failed" });
  });
});
