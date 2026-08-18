import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

interface Row {
  name: string;
  value: number | null;
}

function csvOf(rows: Row[]): string {
  return toCsv<Row>(rows, [
    { header: "Name", value: (r) => r.name },
    { header: "Value", value: (r) => r.value },
  ]);
}

describe("toCsv", () => {
  it("renders a plain row with a BOM and CRLF line endings", () => {
    const csv = csvOf([{ name: "Uniswap", value: 100 }]);
    expect(csv).toBe("﻿Name,Value\r\nUniswap,100\r\n");
  });

  it("quotes and escapes commas, quotes and newlines per RFC 4180", () => {
    const csv = csvOf([{ name: 'Alpha, "the" Protocol\nv2', value: 1 }]);
    expect(csv).toContain('"Alpha, ""the"" Protocol\nv2",1');
  });

  it("renders null/undefined cells as empty", () => {
    const csv = csvOf([{ name: "NoValue", value: null }]);
    expect(csv).toContain("NoValue,\r\n");
  });

  it.each(["=cmd|'/c calc'!A1", "+1+1", "-1+1", "@SUM(A1:A9)", "\tSHELL()"])(
    "neutralizes a formula-leading cell value (%s) with a leading apostrophe",
    (malicious) => {
      const csv = csvOf([{ name: malicious, value: 1 }]);
      const dataLine = csv.split("\r\n")[1];
      expect(dataLine.startsWith(`'${malicious}`) || dataLine.startsWith(`"'${malicious}`)).toBe(true);
    },
  );

  it("still quotes a neutralized formula cell if it also needs RFC 4180 quoting", () => {
    const csv = csvOf([{ name: "=A1,B1", value: 1 }]);
    expect(csv).toContain('"\'=A1,B1",1');
  });
});
