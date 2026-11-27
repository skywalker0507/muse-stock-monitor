#!/usr/bin/env python3
"""Emit Action parameters for importInvestmentEvents from official public feeds."""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

HALT_FEED = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts"
HALT_PAGE = "https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalts"
SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{:010d}.json"
EASTERN = ZoneInfo("America/New_York")
SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9.-]{0,9}\Z")
ACCESSION = re.compile(r"\d{10}-\d{2}-\d{6}\Z")
SEC_ARCHIVE = "https://www.sec.gov/Archives/edgar/data"
ETF = {"QQQ", "QQQM", "SPY", "VOO"}
MARKET_HALT_CODES = {"MWC1", "MWC2", "MWC3"}
RESUMING_CODES = {"T3", "T7", "R1", "R2", "R4", "R9", "C3", "C4", "C9", "C11", "IPOQ", "MWCQ"}


def fetch(url: str, agent: str, limit: int = 4_000_000) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": "application/json, application/rss+xml, text/xml"})
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = response.read(limit + 1)
    if len(payload) > limit:
        raise ValueError("响应超过大小限制")
    return payload


def halt_timestamp(date: str, clock: str) -> datetime:
    # Nasdaq gives New York wall-clock time because trading pauses describe a US session.
    if not re.fullmatch(r"\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?", clock):
        raise ValueError("无法解析暂停时间")
    pattern = "%m/%d/%Y %H:%M:%S.%f" if "." in clock else "%m/%d/%Y %H:%M:%S"
    return datetime.strptime(f"{date} {clock}", pattern).replace(tzinfo=EASTERN).astimezone(timezone.utc)


def parse_halts(payload: bytes, symbols: set[str], now: datetime) -> list[dict]:
    root = ET.fromstring(payload)
    channel = root.find("./channel")
    if channel is None:
        raise ValueError("RSS 缺少 channel")
    events = []
    for item in channel.findall("item"):
        fields = {node.tag.rsplit("}", 1)[-1].lower(): (node.text or "").strip() for node in item}
        code = fields.get("reasoncode", "").upper()
        symbol = "MARKET" if code in MARKET_HALT_CODES else fields.get("issuesymbol", "").upper()
        if (symbol not in symbols and code not in MARKET_HALT_CODES) or code in RESUMING_CODES:
            continue
        occurred = halt_timestamp(fields.get("haltdate", ""), fields.get("halttime", ""))
        resumed = fields.get("resumptiontradetime", "")
        resume_date = fields.get("resumptiondate", "")
        if resumed and resume_date and halt_timestamp(resume_date, resumed) <= now:
            continue
        if not now - timedelta(days=1) <= occurred <= now + timedelta(minutes=1):
            continue
        events.append({
            "id": occurred.strftime("%Y%m%dT%H%M%S%fZ"),
            "symbol": symbol,
            "type": "halt",
            "occurredAt": occurred.isoformat(),
            "sourceUrl": HALT_PAGE,
            "code": code if re.fullmatch(r"[A-Z0-9]{1,12}", code) else "UNKNOWN",
        })
    return events


def parse_sec(payload: bytes, symbol: str, cik: int, now: datetime) -> list[dict]:
    issuer = json.loads(payload)
    if int(issuer["cik"]) != cik or symbol not in {str(ticker).upper() for ticker in issuer["tickers"]}:
        raise ValueError(f"{symbol} 的 SEC 标的身份校验失败")
    recent = issuer["filings"]["recent"]
    events = []
    for index, form in enumerate(recent["form"]):
        if form not in {"8-K", "8-K/A"}:
            continue
        timestamp = recent["acceptanceDateTime"][index]
        occurred = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if occurred.tzinfo is None or not now - timedelta(days=1) <= occurred <= now + timedelta(minutes=1):
            continue
        accession = recent["accessionNumber"][index]
        document = recent["primaryDocument"][index]
        if not ACCESSION.fullmatch(accession) or not document or "/" in document or "\\" in document or document in {".", ".."}:
            continue
        items = re.findall(r"\b\d\.\d{2}\b", recent["items"][index] or "")
        events.append({
            "id": accession,
            "symbol": symbol,
            "type": "sec_filing",
            "occurredAt": occurred.isoformat(),
            "sourceUrl": f"{SEC_ARCHIVE}/{cik}/{accession.replace('-', '')}/{quote(document, safe='')}",
            "items": list(dict.fromkeys(items))[:15],
        })
    return events


def targets(path: Path) -> list[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload["targets"]
    if not isinstance(rows, list):
        raise ValueError("目标文件需要 getInvestmentTargets 的 JSON 响应")
    symbols = []
    for row in rows:
        if row.get("held") is not True and row.get("planned") is not True:
            continue
        symbol = str(row["symbol"]).upper()
        if SYMBOL.fullmatch(symbol) and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def collect(symbols: list[str], sec_agent: str, now: datetime, source: str = "all") -> dict:
    if not symbols:
        return {"events": [], "sourceErrors": [], "source": source}
    events: list[dict] = []
    errors: list[str] = []
    if source in {"all", "halt"}:
        try:
            events.extend(parse_halts(fetch(HALT_FEED, "MuseStockMonitor/1.0"), set(symbols), now))
        except (OSError, ValueError, ET.ParseError):
            errors.append("Nasdaq 暂停交易源获取或解析失败")
    issuers = [symbol for symbol in symbols if symbol not in ETF] if source in {"all", "sec"} else []
    if issuers and not sec_agent:
        errors.append("未配置 SEC_EDGAR_USER_AGENT，跳过 SEC 8-K")
    elif issuers:
        try:
            tickers = json.loads(fetch(SEC_TICKERS, sec_agent))
            ciks = {str(row["ticker"]).upper(): int(row["cik_str"]) for row in tickers.values()}
        except (OSError, ValueError, KeyError, AttributeError, TypeError):
            ciks = {}
            errors.append("SEC 标的映射获取或解析失败")
        if ciks:
            missed = []
            for symbol in issuers:
                cik = ciks.get(symbol)
                if cik is None:
                    missed.append(symbol)
                    continue
                time.sleep(0.25)
                try:
                    events.extend(parse_sec(fetch(SEC_SUBMISSIONS.format(cik), sec_agent), symbol, cik, now))
                except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
                    missed.append(symbol)
            if missed:
                errors.append(("SEC 8-K 未覆盖：" + "、".join(missed))[:150])
    events.sort(key=lambda event: (
        event["type"] == "halt" or bool({"1.03", "4.02"}.intersection(event.get("items", []))),
        datetime.fromisoformat(event["occurredAt"]),
    ), reverse=True)
    return {"events": events[:100], "sourceErrors": errors, "source": source}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", required=True, type=Path, help="getInvestmentTargets Action 的 JSON 响应文件")
    parser.add_argument("--source", choices=("all", "halt", "sec"), default="all")
    args = parser.parse_args()
    try:
        symbols = targets(args.targets)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        parser.error(f"无法读取目标文件：{error}")
    print(json.dumps(collect(symbols, os.environ.get("SEC_EDGAR_USER_AGENT", "").strip(), datetime.now(timezone.utc), args.source),
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
