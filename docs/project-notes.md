# Project notes

The root frontend is the sole authority. Source V3.88 is verified separately from production installation. This is the HTML/JavaScript application with a Swift native host, not the separate SwiftUI rewrite. Financial receivables are historical outstanding balances, not total order amounts. Deposit amount is not proof of receipt; received payment uses paidAmount.

Keep business data, attachments, backups, API keys and notification destinations out of Git. Use synthetic fixtures and isolated data directories. Notifications require explicit bot identity and idempotency. Shipping and settled-stage behavior are covered by regression tests.

Summary monetary values display exactly one fractional digit without changing stored values, individual order detail, exchange-rate or AI-cost precision. Valid literal contact emails supplement AI output; identified payment emails stay separate. Recognition remains an editable preview, never an automatic save.

This export removes historical design documents, chat handoffs, benchmark outputs and live customer examples. The production database was opened read-only only for a local privacy comparison; no records or comparison values are included in the export. No local key file was read or copied.
