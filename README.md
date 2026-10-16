# Isolated RainSync deployment build

This temporary branch holds only deployment workflow configuration. It does not change the application release branch.

The workflow explicitly checks out application source commit `623fa4c2ff6221c046fb3151cc6fac1fabdd8859` and uploads checksummed server and web build artifacts for the authorized deployment. No production secrets are used.
