# Vendor integrations

This directory can contain optional external integrations that are not committed to
source control. To evaluate investment models, clone the TQQQ strategy helpers
here:

```
mkdir -p vendor
git clone https://github.com/dbigham/TQQQ.git vendor/TQQQ
```

Alternatively set the `INVESTMENT_MODEL_REPO` environment variable to point at an
existing checkout before starting the server.
