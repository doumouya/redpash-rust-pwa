<!-- Snapshot of `compare /tmp/well_formed.csv /tmp/wrapped_dossier.csv`,
     run 2026-05-26 ~05:55Z on the 26.04 clone. Fixtures synthesized
     in /tmp (not committed); real `raw_101_clients_fr.csv` and
     `raw_dossier_onecol_tricky.csv` runs land here when they're
     fed to the harness. -->

# parse_and_rescue vs unwrap_csv — compare spike

Measurement per Torv.md 2026-05-26 05:39 ACK · Woz's 04:33 proposal.

| file | impl | rows | cols | encoding | diag | error |
|---|---|---|---|---|---|---|
| well_formed.csv | unwrap_csv | 3 | 3 | utf-8 | — | — |
| well_formed.csv | parse_and_rescue | 0 | 0 | UTF-8 | — | — |
| wrapped_dossier.csv | unwrap_csv | 3 | 3 | utf-8 | — | — |
| wrapped_dossier.csv | parse_and_rescue | 3 | 3 | UTF-8 | — | — |
