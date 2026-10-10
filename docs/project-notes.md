# Project notes

The root frontend is the sole authority. Source V3.85 is verified separately from the installed production version. Financial receivables are historical outstanding balances, not total order amounts. Deposit amount is not proof of receipt; received payment uses paidAmount.

Keep business data, attachments, backups, API keys and notification destinations out of Git. Use synthetic fixtures and isolated data directories. Notifications require explicit bot identity and idempotency. Shipping and settled-stage behavior are covered by regression tests.

This export removes historical design documents, chat handoffs, benchmark outputs and live customer examples. No production database or local key file was opened or copied during export.
