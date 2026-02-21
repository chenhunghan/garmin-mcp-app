# Changelog

## [0.3.0](https://github.com/chenhunghan/garmin-mcp-app/compare/garmin-mcp-app-v0.2.0...garmin-mcp-app-v0.3.0) (2026-02-21)


### Features

* add race predictions and training charts, enhance sleep chart ([c32e41e](https://github.com/chenhunghan/garmin-mcp-app/commit/c32e41edfee70d6381da6f20a2ed1cb7ba93ccbc))


### Bug Fixes

* enhance JSON-RPC message handling to prevent parsing errors ([819867d](https://github.com/chenhunghan/garmin-mcp-app/commit/819867d5d8e353568567ca4daf6a3fb87341b423))
* enhance VO2 Max data transformation for improved accuracy and flexibility ([566cae1](https://github.com/chenhunghan/garmin-mcp-app/commit/566cae1206a9f70023b5395697b3b77f49d694d0))
* improve HRV value selection logic for better data accuracy ([2de375e](https://github.com/chenhunghan/garmin-mcp-app/commit/2de375e115a37ded65849e5b62fbb437901273dd))
* replace ResponsiveContainer with custom size measurement to avoid layout warnings ([ef1a5b0](https://github.com/chenhunghan/garmin-mcp-app/commit/ef1a5b03ecca362d8d9fa1adea5e810e8901a88f))
* set minWidth and minHeight for ResponsiveContainer to prevent layout issues ([7a2885d](https://github.com/chenhunghan/garmin-mcp-app/commit/7a2885d8e5d558af835607e15b780654871565fc))

## [0.2.0](https://github.com/chenhunghan/garmin-mcp-app/compare/garmin-mcp-app-v0.1.0...garmin-mcp-app-v0.2.0) (2026-02-21)


### Features

* add ActivitiesChart component to display activity data ([0124139](https://github.com/chenhunghan/garmin-mcp-app/commit/0124139a04b4dc9056404ae5d47ba51d4a0a07dc))
* add dark mode guidelines and best practices for UI components ([076f817](https://github.com/chenhunghan/garmin-mcp-app/commit/076f817e817efbe06c738bcf6518e134f63ae15a))
* add logout ([d30e982](https://github.com/chenhunghan/garmin-mcp-app/commit/d30e982c251936de21eae4e5b4848babc532b20e))
* add new Garmin Connect metrics and tools ([418326c](https://github.com/chenhunghan/garmin-mcp-app/commit/418326c161cac9a374e6aa4d3ed40bbbdd1b12fb))
* add overflow clipping to body for improved layout control ([f83c58c](https://github.com/chenhunghan/garmin-mcp-app/commit/f83c58c650e5d90488d4e39517f51f402105ff40))
* add shadcn chart ([2e3126c](https://github.com/chenhunghan/garmin-mcp-app/commit/2e3126ca1a479fecfb1c12debc74f9430abfc148))
* add steps data visualization with Recharts ComposedChart ([#2](https://github.com/chenhunghan/garmin-mcp-app/issues/2)) ([027daf1](https://github.com/chenhunghan/garmin-mcp-app/commit/027daf1c34c4167a6aff324f6e1c350042718df6))
* add workout management tools and API endpoints for Garmin Connect ([fc8680f](https://github.com/chenhunghan/garmin-mcp-app/commit/fc8680ffed23e78f1aa47050132a777aeb313c3e))
* block data tools until user completes login in MCP App UI ([#3](https://github.com/chenhunghan/garmin-mcp-app/issues/3)) ([c43d33e](https://github.com/chenhunghan/garmin-mcp-app/commit/c43d33ebcc9c6fc6aec20cfa8a47febb09838842))
* enhance card component integration and update theme variables for seamless embedding ([424eff4](https://github.com/chenhunghan/garmin-mcp-app/commit/424eff45c057f7e53719a36db879a8aa70d70f81))
* implement flattenAppHtml plugin to move app.html after build ([118e488](https://github.com/chenhunghan/garmin-mcp-app/commit/118e4882fd7a89e61c0073a8b9b07ed6e58a147e))
* implement view routing for charts and add support for new chart integration ([f131eaf](https://github.com/chenhunghan/garmin-mcp-app/commit/f131eafd2198ec628cacf5f809e3358fd36a355b))
* improve step charts ([74a5858](https://github.com/chenhunghan/garmin-mcp-app/commit/74a5858d13197452be2b7641242515ea8b129d11))
* improve tooltip styling for better readability and layout ([defdf94](https://github.com/chenhunghan/garmin-mcp-app/commit/defdf94ae5151173be0a63f455e4a0c1487043b5))
* integrate host theme styles and update chart component structure ([41cdc6a](https://github.com/chenhunghan/garmin-mcp-app/commit/41cdc6aed1f6787291541dcfe2d3c1ae17466c02))
* refactor Select component to improve accessibility and usability ([8bf165d](https://github.com/chenhunghan/garmin-mcp-app/commit/8bf165d260118d6b1f4e7a6fb92487b25001e2e8))
* trigger login screen when auth failed with garmin api ([0ef5a5f](https://github.com/chenhunghan/garmin-mcp-app/commit/0ef5a5fb661e6e8ce0252159987bb35e614193ac))
* update color variables for aerobic and anaerobic activities ([fa4d930](https://github.com/chenhunghan/garmin-mcp-app/commit/fa4d93099c8be774da4e00b6ca67dc20f83525da))
* update import maps and CSP settings for React and Recharts integration ([74c6908](https://github.com/chenhunghan/garmin-mcp-app/commit/74c69082f6869e5865c566d880a5ef40c4b5e1b3))


### Bug Fixes

* add prepare script for automatic prek hook install ([2e86503](https://github.com/chenhunghan/garmin-mcp-app/commit/2e86503be44381ee5d931c9377313b327c4ff11a))
* allow vitest to pass with no tests ([89503ac](https://github.com/chenhunghan/garmin-mcp-app/commit/89503ac4a1d15ccaca6cf031ca214a04132ebe07))
* chunk 30d steps requests to stay within Garmin 28-day API limit ([de7b0ad](https://github.com/chenhunghan/garmin-mcp-app/commit/de7b0add2027a0372ca0248d7bba30e7c3801cb7))
* make garmin-check-auth tool visible to model ([0412221](https://github.com/chenhunghan/garmin-mcp-app/commit/04122216b6906f6a197dbe0a7561f9f79e6be736))
* make garmin-logout tool visible to model ([802478c](https://github.com/chenhunghan/garmin-mcp-app/commit/802478c9d4b690b90a0f27a6f17dac84d12af1c3))
* make prepare script tolerate core.hooksPath ([500e2c2](https://github.com/chenhunghan/garmin-mcp-app/commit/500e2c27be644eb92ce060a2ce634b3cf4c64f12))
* update API endpoints for user profile and data retrieval ([193f882](https://github.com/chenhunghan/garmin-mcp-app/commit/193f882e01be91aa303a7e9543de7881067c3602))
* update API request URL to include proxy path ([ba0c579](https://github.com/chenhunghan/garmin-mcp-app/commit/ba0c57968092de82bc481d7509889b40778bb904))
