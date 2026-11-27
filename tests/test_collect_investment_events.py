import json
import unittest
from datetime import datetime, timezone

from scripts.collect_investment_events import parse_halts, parse_sec


class OfficialEventsTests(unittest.TestCase):
    def test_rss_uses_halt_time_and_skips_resumed_items(self):
        xml = b"""<rss xmlns:ndaq="https://www.nasdaqtrader.com"><channel>
          <item><ndaq:IssueSymbol>GOOG</ndaq:IssueSymbol><ndaq:HaltDate>11/27/2026</ndaq:HaltDate>
          <ndaq:HaltTime>09:31:05</ndaq:HaltTime><ndaq:ReasonCode>T1</ndaq:ReasonCode></item>
          <item><ndaq:IssueSymbol>MSFT</ndaq:IssueSymbol><ndaq:HaltDate>11/27/2026</ndaq:HaltDate>
          <ndaq:HaltTime>09:41:00</ndaq:HaltTime><ndaq:ReasonCode>T3</ndaq:ReasonCode></item>
          <item><ndaq:IssueSymbol>NVDA</ndaq:IssueSymbol><ndaq:HaltDate>11/27/2026</ndaq:HaltDate>
          <ndaq:HaltTime>09:38:00</ndaq:HaltTime><ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
          <ndaq:ResumptionDate>11/27/2026</ndaq:ResumptionDate><ndaq:ResumptionTradeTime>09:44:00</ndaq:ResumptionTradeTime></item>
          <item><ndaq:HaltDate>11/27/2026</ndaq:HaltDate><ndaq:HaltTime>09:48:00</ndaq:HaltTime>
          <ndaq:ReasonCode>MWC1</ndaq:ReasonCode></item></channel></rss>"""
        now = datetime(2026, 11, 27, 15, tzinfo=timezone.utc)
        events = parse_halts(xml, {"GOOG", "MSFT", "NVDA"}, now)
        self.assertEqual([event["symbol"] for event in events], ["GOOG", "MARKET"])
        self.assertEqual(events[0]["occurredAt"], "2026-11-27T14:31:05+00:00")

    def test_sec_preserves_accession_and_material_items(self):
        payload = json.dumps({
            "cik": "1652044", "tickers": ["GOOG", "GOOGL"],
            "filings": {"recent": {
                "form": ["8-K", "8-K/A", "10-Q"],
                "acceptanceDateTime": ["2026-11-27T14:00:00.000Z", "2026-11-25T14:00:00Z", "2026-11-27T13:00:00Z"],
                "accessionNumber": ["0001652044-26-000001", "0001652044-26-000002", "0001652044-26-000003"],
                "primaryDocument": ["report.htm", "other.htm", "quarterly.htm"],
                "items": ["4.02,9.01", "5.02", ""],
            }},
        }).encode()
        now = datetime(2026, 11, 27, 15, tzinfo=timezone.utc)
        events = parse_sec(payload, "GOOG", 1652044, now)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["items"], ["4.02", "9.01"])
        self.assertTrue(events[0]["sourceUrl"].endswith("/1652044/000165204426000001/report.htm"))
        with self.assertRaises(ValueError):
            parse_sec(payload, "MSFT", 1652044, now)


if __name__ == "__main__":
    unittest.main()
