/**
 * Pre-framework Jest setup.
 *
 * The settings-UI tests only need jsdom's `document`. SwarmUI browser globals
 * (genericRequest, registerNewTool) are used solely by the controller's I/O
 * paths, which the tests don't exercise — so we intentionally do NOT load
 * SwarmUI's wwwroot scripts here. Tests that need a global mock it explicitly.
 */
