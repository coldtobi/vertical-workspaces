/**
 * V-Shell (Vertical Workspaces)
 * appDisplay.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2022 - 2024
 * @license    GPL-3.0
 *
 */

'use strict';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

let Me;
let opt;
// gettext
let _;

let _timeouts;

const APP_ICON_TITLE_EXPAND_TIME = 200;
const APP_ICON_TITLE_COLLAPSE_TIME = 100;

const shellVersion46 = !Clutter.Container; // Container has been removed in 46

function _getCategories(info) {
    let categoriesStr = info.get_categories();
    if (!categoriesStr)
        return [];
    return categoriesStr.split(';');
}

function _listsIntersect(a, b) {
    for (let itemA of a) {
        if (b.includes(itemA))
            return true;
    }
    return false;
}

export const AppDisplayModule = class {
    constructor(me) {
        Me = me;
        opt = Me.opt;
        _  = Me.gettext;

        this._firstActivation = true;
        this.moduleEnabled = false;
        this._overrides = null;

        this._appGridLayoutSettings =  null;
        this._appDisplayScrollConId =  0;
        this._appSystemStateConId =  0;
        this._appGridLayoutConId =  0;
        this._origAppViewItemAcceptDrop =  null;
        this._updateFolderIcons =  0;
    }

    cleanGlobals() {
        Me = null;
        opt = null;
        _ = null;
    }

    update(reset) {
        this._removeTimeouts();
        this.moduleEnabled = opt.get('appDisplayModule');
        const conflict = false;

        reset = reset || !this.moduleEnabled || conflict;

        // don't touch the original code if module disabled
        if (reset && !this._firstActivation) {
            this._disableModule();
            this.moduleEnabled = false;
        } else if (!reset) {
            this._firstActivation = false;
            this._activateModule();
        }
        if (reset && this._firstActivation) {
            this.moduleEnabled = false;
            console.debug('  AppDisplayModule - Keeping untouched');
        }
    }

    _activateModule() {
        Me.Modules.iconGridModule.update();

        if (!this._overrides)
            this._overrides = new Me.Util.Overrides();

        _timeouts = {};

        // Common
        // this._overrides.addOverride('BaseAppViewCommon', AppDisplay.BaseAppView.prototype, BaseAppViewCommon);
        // instead of overriding inaccessible BaseAppView class, we override its children - AppDisplay and FolderView
        this._overrides.addOverride('BaseAppViewCommonApp', AppDisplay.AppDisplay.prototype, BaseAppViewCommon);
        this._overrides.addOverride('BaseAppViewCommonFolder', AppDisplay.FolderView.prototype, BaseAppViewCommon);
        this._overrides.addOverride('FolderView', AppDisplay.FolderView.prototype, FolderView);
        this._overrides.addOverride('AppDisplay', AppDisplay.AppDisplay.prototype, AppDisplayCommon);
        this._overrides.addOverride('AppViewItem', AppDisplay.AppViewItem.prototype, AppViewItemCommon);
        this._overrides.addOverride('FolderIcon', AppDisplay.FolderIcon.prototype, FolderIcon);
        if (opt.APP_GRID_ACTIVE_PREVIEW)
            this._overrides.addOverride('ActiveFolderIcon', AppDisplay.FolderIcon, ActiveFolderIcon);
        this._overrides.addOverride('AppIcon', AppDisplay.AppIcon.prototype, AppIcon);

        if (opt.ORIENTATION === Clutter.Orientation.VERTICAL) {
            // this._overrides.addOverride('BaseAppViewVertical', AppDisplay.BaseAppView.prototype, BaseAppViewVertical);
            this._overrides.addOverride('BaseAppViewVerticalApp', AppDisplay.AppDisplay.prototype, BaseAppViewVertical);
            this._overrides.addOverride('BaseAppViewVerticalFolder', AppDisplay.FolderView.prototype, BaseAppViewVertical);
            this._overrides.addOverride('AppDisplayVertical', AppDisplay.AppDisplay.prototype, AppDisplayVertical);
        }

        // Custom App Grid
        this._overrides.addOverride('AppFolderDialog', AppDisplay.AppFolderDialog.prototype, AppFolderDialog);

        // BaseAppViewGridLayout is not exported, we can only access current instance
        this._overrides.addOverride('BaseAppViewGridLayout', Main.overview._overview.controls._appDisplay._appGridLayout, BaseAppViewGridLayout);
        // this._overrides.addOverride('FolderGrid', AppDisplay.FolderGrid.prototype, FolderGrid);

        this._setAppDisplayOrientation(opt.ORIENTATION === Clutter.Orientation.VERTICAL);
        this._updateDND();

        const appDisplay = Main.overview._overview.controls._appDisplay;

        if (!this._originalWorkId)
            this._originalWorkId = appDisplay._redisplayWorkId;
        if (!this._newWorkId) {
            appDisplay._redisplayWorkId = Main.initializeDeferredWork(appDisplay, () => {
                appDisplay._redisplay();
                if (appDisplay._overviewHiddenId === 0)
                    appDisplay._overviewHiddenId = Main.overview.connect('hidden', () => appDisplay.goToPage(0));
            });
            this._newWorkId = appDisplay._redisplayWorkId;
        } else {
            appDisplay._redisplayWorkId = this._newWorkId;
        }


        if (!Main.sessionMode.isGreeter)
            this._updateAppDisplayProperties();

        console.debug('  AppDisplayModule - Activated');
    }

    _disableModule() {
        Me.Modules.iconGridModule.update(true);

        if (this._overrides)
            this._overrides.removeAll();
        this._overrides = null;

        const reset = true;
        this._setAppDisplayOrientation(false);
        this._updateAppDisplayProperties(reset);
        this._updateDND(reset);
        this._restoreOverviewGroup();
        this._removeStatusMessage();

        // register a new appDisplay workId so the original code will be called from the callback
        const appDisplay = Main.overview._overview.controls._appDisplay;
        appDisplay._redisplayWorkId = this._originalWorkId;

        console.debug('  AppDisplayModule - Disabled');
    }

    _removeTimeouts() {
        if (_timeouts) {
            Object.values(_timeouts).forEach(t => {
                if (t)
                    GLib.source_remove(t);
            });
            _timeouts = null;
        }
    }

    _setAppDisplayOrientation(vertical = false) {
        const CLUTTER_ORIENTATION = vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        // app display to vertical has issues - page indicator not working
        // global appDisplay orientation switch is not built-in
        let appDisplay = Main.overview._overview._controls._appDisplay;
        // following line itself only changes in which axis will operate overshoot detection which switches appDisplay pages while dragging app icon to vertical
        appDisplay._orientation = CLUTTER_ORIENTATION;
        appDisplay._grid.layoutManager._orientation = CLUTTER_ORIENTATION;
        appDisplay._swipeTracker.orientation = CLUTTER_ORIENTATION;
        appDisplay._swipeTracker._reset();
        if (vertical) {
            appDisplay._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);

            // move and change orientation of page indicators
            const pageIndicators = appDisplay._pageIndicators;
            pageIndicators.vertical = true;
            appDisplay._box.vertical = false;
            pageIndicators.x_expand = false;
            pageIndicators.y_align = Clutter.ActorAlign.CENTER;
            pageIndicators.x_align = Clutter.ActorAlign.START;

            // moving these bars needs more patching of the appDisplay's code
            // for now we just change bars style to be more like vertically oriented arrows indicating direction to prev/next page
            appDisplay._nextPageIndicator.add_style_class_name('nextPageIndicator');
            appDisplay._prevPageIndicator.add_style_class_name('prevPageIndicator');

            // setting their x_scale to 0 removes the arrows and avoid allocation issues compared to .hide() them
            appDisplay._nextPageArrow.scale_x = 0;
            appDisplay._prevPageArrow.scale_x = 0;
        } else {
            appDisplay._scrollView.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
            if (this._appDisplayScrollConId) {
                appDisplay._adjustment.disconnect(this._appDisplayScrollConId);
                this._appDisplayScrollConId = 0;
            }

            // restore original page indicators
            const pageIndicators = appDisplay._pageIndicators;
            pageIndicators.vertical = false;
            appDisplay._box.vertical = true;
            pageIndicators.x_expand = true;
            pageIndicators.y_align = Clutter.ActorAlign.END;
            pageIndicators.x_align = Clutter.ActorAlign.CENTER;

            // put back touch friendly navigation buttons
            const scrollContainer = appDisplay._scrollView.get_parent();
            if (appDisplay._hintContainer && !appDisplay._hintContainer.get_parent()) {
                scrollContainer.add_child(appDisplay._hintContainer);
                // the hit container covers the entire app grid and added at the top of the stack blocks DND drops
                // so it needs to be pushed below
                scrollContainer.set_child_below_sibling(appDisplay._hintContainer, null);
            }

            appDisplay._nextPageArrow.scale_x = 1;
            appDisplay._prevPageArrow.scale_x = 1;

            appDisplay._nextPageIndicator.remove_style_class_name('nextPageIndicator');
            appDisplay._prevPageIndicator.remove_style_class_name('prevPageIndicator');
        }

        // value for page indicator is calculated from scroll adjustment, horizontal needs to be replaced by vertical
        appDisplay._adjustment = vertical
            ? appDisplay._scrollView.get_vscroll_bar().adjustment
            : appDisplay._scrollView.get_hscroll_bar().adjustment;

        // no need to connect already connected signal (wasn't removed the original one before)
        if (!vertical) {
            // reset used appDisplay properties
            Main.overview._overview._controls._appDisplay.scale_y = 1;
            Main.overview._overview._controls._appDisplay.scale_x = 1;
            Main.overview._overview._controls._appDisplay.opacity = 255;
            return;
        }

        // update appGrid dot pages indicators
        this._appDisplayScrollConId = appDisplay._adjustment.connect('notify::value', adj => {
            const value = adj.value / adj.page_size;
            appDisplay._pageIndicators.setCurrentPosition(value);
        });
    }

    // Set App Grid columns, rows, icon size, incomplete pages
    _updateAppDisplayProperties(reset = false) {
        opt._appGridNeedsRedisplay = false;
        // columns, rows, icon size
        const appDisplay = Main.overview._overview._controls._appDisplay;
        appDisplay.visible = true;
        if (reset) {
            appDisplay._grid.layoutManager.fixedIconSize = -1;
            appDisplay._grid.layoutManager.allow_incomplete_pages = true;
            appDisplay._grid._currentMode = -1;
            appDisplay._grid.setGridModes();
            if (this._appGridLayoutSettings) {
                this._appGridLayoutSettings.disconnect(this._appGridLayoutConId);
                this._appGridLayoutConId = 0;
                this._appGridLayoutSettings = null;
            }
            appDisplay._redisplay();

            appDisplay._grid.set_style('');
            this._updateAppGrid(reset);
        } else {
            // update grid on layout reset
            if (!this._appGridLayoutSettings) {
                this._appGridLayoutSettings = Me.getSettings('org.gnome.shell');
                this._appGridLayoutConId = this._appGridLayoutSettings.connect('changed::app-picker-layout', this._updateLayout);
            }

            appDisplay._grid.layoutManager.allow_incomplete_pages = opt.APP_GRID_ALLOW_INCOMPLETE_PAGES;
            // appDisplay._grid.set_style(`column-spacing: ${opt.APP_GRID_SPACING}px; row-spacing: ${opt.APP_GRID_SPACING}px;`);
            // APP_GRID_SPACING constant is used for grid dimensions calculation
            // but sometimes the actual grid spacing properties affect/change the calculated size, therefore we set it lower to avoid this problem
            // main app grid always use available space and the spacing is optimized for the grid dimensions
            appDisplay._grid.set_style('column-spacing: 5px; row-spacing: 5px;');

            // force redisplay
            appDisplay._grid._currentMode = -1;
            appDisplay._grid.setGridModes();
            appDisplay._grid.layoutManager.fixedIconSize = opt.APP_GRID_ICON_SIZE;
            // avoid resetting appDisplay before startup animation
            // x11 shell restart skips startup animation
            if (!Main.layoutManager._startingUp) {
                this._updateAppGrid();
            } else if (Main.layoutManager._startingUp && (Meta.is_restart() || Me.Util.dashIsDashToDock())) {
                _timeouts.three = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                    this._updateAppGrid();
                    _timeouts.three = 0;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _updateDND(reset) {
        if (!reset) {
            if (!this._appSystemStateConId && opt.APP_GRID_INCLUDE_DASH >= 3) {
                this._appSystemStateConId = Shell.AppSystem.get_default().connect(
                    'app-state-changed',
                    () => {
                        this._updateFolderIcons = true;
                        Main.overview._overview.controls._appDisplay._redisplay();
                    }
                );
            }
        } else if (this._appSystemStateConId) {
            Shell.AppSystem.get_default().disconnect(this._appSystemStateConId);
            this._appSystemStateConId = 0;
        }
    }

    _restoreOverviewGroup() {
        Main.overview.dash.showAppsButton.checked = false;
        Main.layoutManager.overviewGroup.opacity = 255;
        Main.layoutManager.overviewGroup.scale_x = 1;
        Main.layoutManager.overviewGroup.scale_y = 1;
        Main.layoutManager.overviewGroup.hide();
        Main.overview._overview._controls._appDisplay.translation_x = 0;
        Main.overview._overview._controls._appDisplay.translation_y = 0;
        Main.overview._overview._controls._appDisplay.visible = true;
        Main.overview._overview._controls._appDisplay.opacity = 255;
    }

    // update all invalid positions that may be result of grid/icon size change
    _updateIconPositions() {
        const appDisplay = Main.overview._overview._controls._appDisplay;
        const layout = JSON.stringify(global.settings.get_value('app-picker-layout').recursiveUnpack());
        // if app grid layout is empty, sort source alphabetically to avoid misplacing
        if (layout === JSON.stringify([]) && appDisplay._sortOrderedItemsAlphabetically)
            appDisplay._sortOrderedItemsAlphabetically();
        const icons = [...appDisplay._orderedItems];
        for (let i = 0; i < icons.length; i++)
            appDisplay._moveItem(icons[i], -1, -1);
    }

    _removeIcons() {
        const appDisplay = Main.overview._overview._controls._appDisplay;
        const icons = [...appDisplay._orderedItems];
        for (let i = 0; i < icons.length; i++) {
            const icon = icons[i];
            if (icon._dialog)
                Main.layoutManager.overviewGroup.remove_child(icon._dialog);
            appDisplay._removeItem(icon);
            icon.destroy();
        }
        appDisplay._folderIcons = [];
    }

    _removeStatusMessage() {
        if (Me._vShellStatusMessage) {
            if (Me._vShellMessageTimeoutId) {
                GLib.source_remove(Me._vShellMessageTimeoutId);
                Me._vShellMessageTimeoutId = 0;
            }
            Me._vShellStatusMessage.destroy();
            Me._vShellStatusMessage = null;
        }
    }

    _updateLayout(settings, key) {
        const currentValue = JSON.stringify(settings.get_value(key).deep_unpack());
        const emptyValue = JSON.stringify([]);
        const customLayout = currentValue !== emptyValue;
        if (!customLayout) {
            this._updateAppGrid();
        }
    }

    _updateAppGrid(reset = false, callback) {
        const appDisplay = Main.overview._overview._controls._appDisplay;
        // reset the grid only if called directly without args or if all folders where removed by using reset button in Settings window
        // otherwise this function is called every time a user moves icon to another position as a settings callback

        // force update icon size using adaptToSize(), the page size cannot be the same as the current one
        appDisplay._grid.layoutManager._pageWidth += 1;
        appDisplay._grid.layoutManager.adaptToSize(appDisplay._grid.layoutManager._pageWidth - 1, appDisplay._grid.layoutManager._pageHeight);

        // don't delay the first screen lock whe extensions are rebased
        // removing icons takes time and with other
        if (!Main.sessionMode.isLocked)
            this._removeIcons();

        appDisplay._redisplay();

        // don't realize appDisplay on disable, or at startup if disabled
        // always realize appDisplay otherwise to avoid errors while opening folders (that I was unable to trace)
        if (reset || (!opt.APP_GRID_PERFORMANCE && callback)) {
            this._removeStatusMessage();
            if (callback)
                callback();
            return;
        }

        // workaround - silently realize appDisplay
        // appDisplay and its content must be "visible" (opacity > 0) on the screen (within monitor geometry)
        // to realize its objects
        // this action takes some time and affects animations during the first use
        // if we do it invisibly before user needs it, it can improve the user's experience

        this._exposeAppGrid();

        // let the main loop process our changes before continuing
        _timeouts.one = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._updateIconPositions();
            if (appDisplay._sortOrderedItemsAlphabetically) {
                appDisplay._sortOrderedItemsAlphabetically();
                appDisplay._grid.layoutManager._pageWidth += 1;
                appDisplay._grid.layoutManager.adaptToSize(appDisplay._grid.layoutManager._pageWidth - 1, appDisplay._grid.layoutManager._pageHeight);
                appDisplay._setLinearPositions(appDisplay._orderedItems);
            }

            appDisplay._redisplay();
            // realize also all app folders (by opening them) so the first popup is as smooth as the second one
            // let the main loop process our changes before continuing
            _timeouts.two = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._restoreAppGrid();
                Me._resetInProgress = false;
                this._removeStatusMessage();

                if (callback)
                    callback();

                _timeouts.two = 0;
                return GLib.SOURCE_REMOVE;
            });
            _timeouts.one = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _exposeAppGrid() {
        const overviewGroup = Main.layoutManager.overviewGroup;
        if (!overviewGroup.visible) {
            // scale down the overviewGroup so it don't cover uiGroup
            overviewGroup.scale_y = 0.001;
            // make it invisible to the eye, but visible for the renderer
            overviewGroup.opacity = 1;
            // if overview is hidden, show it
            overviewGroup.visible = true;
        }

        const appDisplay = Main.overview._overview._controls._appDisplay;
        appDisplay.opacity = 1;

        // find usable value, sometimes it's one, sometime the other...
        let [x, y] = appDisplay.get_position();
        let { x1, y1 } = appDisplay.allocation;
        x = x === Infinity ? 0 : x;
        y = y === Infinity ? 0 : y;
        x1 = x1 === Infinity ? 0 : x1;
        y1 = y1 === Infinity ? 0 : y1;
        appDisplay.translation_x = -(x ? x : x1);
        appDisplay.translation_y = -(y ? y : y1);
        this._exposeAppFolders();
    }

    _exposeAppFolders() {
        const appDisplay = Main.overview._overview._controls._appDisplay;
        appDisplay._folderIcons.forEach(d => {
            d._ensureFolderDialog();
            d._dialog._updateFolderSize();
            d._dialog.scale_y = 0.0001;
            d._dialog.show();
        });
    }

    _restoreAppGrid() {
        const appDisplay = Main.overview._overview._controls._appDisplay;
        appDisplay.translation_x = 0;
        appDisplay.translation_y = 0;
        // appDisplay.opacity = 0;
        this._hideAppFolders();

        const overviewGroup = Main.layoutManager.overviewGroup;
        if (!Main.overview._shown)
            overviewGroup.hide();
        overviewGroup.scale_y = 1;
        overviewGroup.opacity = 255;

        this._removeStatusMessage();
    }

    _hideAppFolders() {
        const appDisplay = Main.overview._overview._controls._appDisplay;
        appDisplay._folderIcons.forEach(d => {
            if (d._dialog) {
                d._dialog._updateFolderSize();
                d._dialog.hide();
                d._dialog.scale_y = 1;
            }
        });
    }

    _getWindowApp(metaWin) {
        const tracker = Shell.WindowTracker.get_default();
        return tracker.get_window_app(metaWin);
    }

    _getAppLastUsedWindow(app) {
        let recentWin;
        global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null).forEach(metaWin => {
            const winApp = this._getWindowApp(metaWin);
            if (!recentWin && winApp === app)
                recentWin = metaWin;
        });
        return recentWin;
    }

    _getAppRecentWorkspace(app) {
        const recentWin = this._getAppLastUsedWindow(app);
        if (recentWin)
            return recentWin.get_workspace();

        return null;
    }
};

const AppDisplayVertical = {
    // correction of the appGrid size when page indicators were moved from the bottom to the right
    adaptToSize(width, height) {
        const [, indicatorWidth] = this._pageIndicators.get_preferred_width(-1);
        width -= indicatorWidth;

        this._grid.findBestModeForSize(width, height);

        const adaptToSize = AppDisplay.BaseAppView.prototype.adaptToSize.bind(this);
        adaptToSize(width, height);
    },
};

function _getViewFromIcon(icon) {
    for (let parent = icon.get_parent(); parent; parent = parent.get_parent()) {
        if (parent instanceof AppDisplay.AppDisplay || parent instanceof AppDisplay.FolderView) {
            return parent;
        }
    }
    return null;
}

const AppDisplayCommon = {
    _ensureDefaultFolders() {
        // disable creation of default folders if user deleted them
    },

    // apps load adapted for custom sorting and including dash items
    _loadApps() {
        let appIcons = [];
        const runningApps = Shell.AppSystem.get_default().get_running().map(a => a.id);

        this._appInfoList = Shell.AppSystem.get_default().get_installed().filter(appInfo => {
            try {
                appInfo.get_id(); // catch invalid file encodings
            } catch (e) {
                return false;
            }

            const appIsRunning = runningApps.includes(appInfo.get_id());
            const appIsFavorite = this._appFavorites.isFavorite(appInfo.get_id());
            const excludeApp = (opt.APP_GRID_EXCLUDE_RUNNING && appIsRunning) || (opt.APP_GRID_EXCLUDE_FAVORITES && appIsFavorite);

            return this._parentalControlsManager.shouldShowApp(appInfo) && !excludeApp;
        });

        let apps = this._appInfoList.map(app => app.get_id());

        let appSys = Shell.AppSystem.get_default();

        const appsInsideFolders = new Set();
        this._folderIcons = [];
        if (!opt.APP_GRID_USAGE) {
            let folders = this._folderSettings.get_strv('folder-children');
            folders.forEach(id => {
                let path = `${this._folderSettings.path}folders/${id}/`;
                let icon = this._items.get(id);
                if (!icon) {
                    icon = new AppDisplay.FolderIcon(id, path, this);
                    icon.connect('apps-changed', () => {
                        this._redisplay();
                        this._savePages();
                    });
                    icon.connect('notify::pressed', () => {
                        if (icon.pressed)
                            this.updateDragFocus(icon);
                    });
                } else if (this._updateFolderIcons && opt.APP_GRID_EXCLUDE_RUNNING) {
                // if any app changed its running state, update folder icon
                    icon.icon.update();
                }

                // remove empty folder icons
                if (!icon.visible) {
                    icon.destroy();
                    return;
                }

                appIcons.push(icon);
                this._folderIcons.push(icon);

                icon.getAppIds().forEach(appId => appsInsideFolders.add(appId));
            });
        }

        // reset request to update active icon
        this._updateFolderIcons = false;

        // Allow dragging of the icon only if the Dash would accept a drop to
        // change favorite-apps. There are no other possible drop targets from
        // the app picker, so there's no other need for a drag to start,
        // at least on single-monitor setups.
        // This also disables drag-to-launch on multi-monitor setups,
        // but we hope that is not used much.
        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        apps.forEach(appId => {
            if (!opt.APP_GRID_USAGE && appsInsideFolders.has(appId))
                return;

            let icon = this._items.get(appId);
            if (!icon) {
                let app = appSys.lookup_app(appId);
                icon = new AppDisplay.AppIcon(app, { isDraggable });
                icon.connect('notify::pressed', () => {
                    if (icon.pressed)
                        this.updateDragFocus(icon);
                });
            }

            appIcons.push(icon);
        });

        // At last, if there's a placeholder available, add it
        if (this._placeholder)
            appIcons.push(this._placeholder);

        return appIcons;
    },

    // support active preview icons
    _onDragBegin(overview, source) {
        if (source._sourceItem)
            source = source._sourceItem;

        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);

        this._appGridLayout.showPageIndicators();
        this._dragFocus = null;
        this._swipeTracker.enabled = false;

        // When dragging from a folder dialog, the dragged app icon doesn't
        // exist in AppDisplay. We work around that by adding a placeholder
        // icon that is either destroyed on cancel, or becomes the effective
        // new icon when dropped.
        if (/* AppDisplay.*/_getViewFromIcon(source) instanceof AppDisplay.FolderView ||
            (opt.APP_GRID_EXCLUDE_FAVORITES && this._appFavorites.isFavorite(source.id)))
            this._ensurePlaceholder(source);
    },

    _ensurePlaceholder(source) {
        if (this._placeholder)
            return;

        if (source._sourceItem)
            source = source._sourceItem;

        const appSys = Shell.AppSystem.get_default();
        const app = appSys.lookup_app(source.id);

        const isDraggable =
            global.settings.is_writable('favorite-apps') ||
            global.settings.is_writable('app-picker-layout');

        this._placeholder = new AppDisplay.AppIcon(app, { isDraggable });
        this._placeholder.connect('notify::pressed', () => {
            if (this._placeholder?.pressed)
                this.updateDragFocus(this._placeholder);
        });
        this._placeholder.scaleAndFade();
        this._redisplay();
    },

    // accept source from active folder preview
    acceptDrop(source) {
        if (opt.APP_GRID_USAGE)
            return false;
        if (source._sourceItem)
            source = source._sourceItem;

        if (!this._acceptDropCommon(source))
            return false;

        let view = /* AppDisplay.*/_getViewFromIcon(source);
        if (view instanceof AppDisplay.FolderView)
            view.removeApp(source.app);

        if (this._currentDialog)
            this._currentDialog.popdown();

        if (opt.APP_GRID_EXCLUDE_FAVORITES && this._appFavorites.isFavorite(source.id))
            this._appFavorites.removeFavorite(source.id);

        return true;
    },
};

const BaseAppViewVertical = {
    after__init() {
        this._grid.layoutManager._orientation = Clutter.Orientation.VERTICAL;
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);
        this._orientation = Clutter.Orientation.VERTICAL;
        this._swipeTracker.orientation = Clutter.Orientation.VERTICAL;
        this._swipeTracker._reset();
        this._pageIndicators.vertical = true;
        this._box.vertical = false;
        this._pageIndicators.x_expand = false;
        this._pageIndicators.y_align = Clutter.ActorAlign.CENTER;
        this._pageIndicators.x_align = Clutter.ActorAlign.START;
        this._pageIndicators.set_style('margin-right: 10px;');
        // moving these bars needs more patching of the this's code
        // for now we just change bars style to be more like vertically oriented arrows indicating direction to prev/next page
        this._nextPageIndicator.add_style_class_name('nextPageIndicator');
        this._prevPageIndicator.add_style_class_name('prevPageIndicator');

        // setting their x_scale to 0 removes the arrows and avoid allocation issues compared to .hide() them
        this._nextPageArrow.scale_x = 0;
        this._prevPageArrow.scale_x = 0;

        this._adjustment = this._scrollView.get_vscroll_bar().adjustment;

        this._adjustment.connect('notify::value', adj => {
            const value = adj.value / adj.page_size;
            this._pageIndicators.setCurrentPosition(value);
        });
    },
};

const BaseAppViewCommon = {
    _sortOrderedItemsAlphabetically(icons = null) {
        if (!icons)
            icons = this._orderedItems;
        icons.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    },

    _setLinearPositions(icons) {
        const { itemsPerPage } = this._grid;
        icons.forEach((icon, i) => {
            const page = Math.floor(i / itemsPerPage);
            const position = i % itemsPerPage;
            try {
                this._moveItem(icon, page, position);
            } catch (e) {
                console.warn(`Warning:${e}`);
            }
        });
    },

    // adds sorting options and option to add favorites and running apps
    _redisplay() {
        if (this._folderIcons) {
            this._folderIcons.forEach(icon => {
                icon.view._redisplay();
            });
        }
        let oldApps = this._orderedItems.slice();
        let oldAppIds = oldApps.map(icon => icon.id);

        let newApps = this._loadApps().sort(this._compareItems.bind(this));
        let newAppIds = newApps.map(icon => icon.id);

        let addedApps = newApps.filter(icon => !oldAppIds.includes(icon.id));
        let removedApps = oldApps.filter(icon => !newAppIds.includes(icon.id));

        // Remove old app icons
        removedApps.forEach(icon => {
            this._removeItem(icon);
            icon.destroy();
        });

        // Add new app icons, or move existing ones
        newApps.forEach(icon => {
            const [page, position] = this._getItemPosition(icon);
            if (addedApps.includes(icon)) {
                this._addItem(icon, page, position);
            } else if (page !== -1 && position !== -1) {
                this._moveItem(icon, page, position);
            } else {
                // App is part of a folder
            }
        });

        // different options for root app grid and app folders
        const thisIsFolder = this instanceof AppDisplay.FolderView;
        const thisIsAppDisplay = !thisIsFolder;
        if ((opt.APP_GRID_ORDER && thisIsAppDisplay) ||
        (opt.APP_FOLDER_ORDER && thisIsFolder)) {
            // const { itemsPerPage } = this._grid;
            let appIcons = this._orderedItems;
            // sort all alphabetically
            this._sortOrderedItemsAlphabetically(appIcons);
            // appIcons.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            // then sort used apps by usage
            if ((opt.APP_GRID_USAGE && thisIsAppDisplay) ||
                (opt.APP_FOLDER_USAGE && thisIsFolder))
                appIcons.sort((a, b) => Shell.AppUsage.get_default().compare(a.app.id, b.app.id));

            // sort favorites first
            if (opt.APP_GRID_DASH_FIRST) {
                const fav = Object.keys(this._appFavorites._favorites);
                appIcons.sort((a, b) => {
                    let aFav = fav.indexOf(a.id);
                    if (aFav < 0)
                        aFav = 999;
                    let bFav = fav.indexOf(b.id);
                    if (bFav < 0)
                        bFav = 999;
                    return bFav < aFav;
                });
            }

            // sort running first
            if (opt.APP_GRID_DASH_FIRST && thisIsAppDisplay)
                appIcons.sort((a, b) => a.app.get_state() !== Shell.AppState.RUNNING && b.app.get_state() === Shell.AppState.RUNNING);

            if (opt.APP_GRID_FOLDERS_FIRST)
                appIcons.sort((a, b) => b._folder && !a._folder);
            else if (opt.APP_GRID_FOLDERS_LAST)
                appIcons.sort((a, b) => a._folder && !b._folder);

            this._setLinearPositions(appIcons);

            this._orderedItems = appIcons;
        }

        this.emit('view-loaded');
        if (!opt.APP_GRID_ALLOW_INCOMPLETE_PAGES) {
            for (let i = 0; i < this._grid.nPages; i++)
                this._grid.layoutManager._fillItemVacancies(i);
        }
    },

    _canAccept(source) {
        return source instanceof AppDisplay.AppViewItem;
    },

    // this method is replacing BaseAppVew.acceptDrop which can't be overridden directly
    _acceptDropCommon(source) {
        const dropTarget = this._dropTarget;
        delete this._dropTarget;

        if (!this._canAccept(source))
            return false;

        if (dropTarget === this._prevPageIndicator ||
            dropTarget === this._nextPageIndicator) {
            let increment;

            increment = dropTarget === this._prevPageIndicator ? -1 : 1;

            const { currentPage, nPages } = this._grid;
            const page = Math.min(currentPage + increment, nPages);
            const position = page < nPages ? -1 : 0;

            this._moveItem(source, page, position);
            this.goToPage(page);
        } else if (this._delayedMoveData) {
            // Dropped before the icon was moved
            const { page, position } = this._delayedMoveData;

            try {
                this._moveItem(source, page, position);
            } catch (e) {
                console.warn(`Warning:${e}`);
            }
            this._removeDelayedMove();
        }

        return true;
    },

    // support active preview icons
    _onDragMotion(dragEvent) {
        if (!(dragEvent.source instanceof AppDisplay.AppViewItem))
            return DND.DragMotionResult.CONTINUE;

        if (dragEvent.source._sourceItem)
            dragEvent.source = dragEvent.source._sourceItem;

        const appIcon = dragEvent.source;

        if (appIcon instanceof AppDisplay.AppViewItem) {
            if (!this._dragMaybeSwitchPageImmediately(dragEvent)) {
                // Two ways of switching pages during DND:
                // 1) When "bumping" the cursor against the monitor edge, we switch
                //    page immediately.
                // 2) When hovering over the next-page indicator for a certain time,
                //    we also switch page.

                const { targetActor } = dragEvent;

                if (targetActor === this._prevPageIndicator ||
                            targetActor === this._nextPageIndicator)
                    this._maybeSetupDragPageSwitchInitialTimeout(dragEvent);
                else
                    this._resetDragPageSwitch();
            }
        }

        const thisIsFolder = this instanceof AppDisplay.FolderView;
        const thisIsAppDisplay = !thisIsFolder;
        if ((!opt.APP_GRID_ORDER && thisIsAppDisplay) || (!opt.APP_FOLDER_ORDER  && thisIsFolder))
            this._maybeMoveItem(dragEvent);

        return DND.DragMotionResult.CONTINUE;
    },
};

const BaseAppViewGridLayout = {
    _getIndicatorsWidth(box) {
        const [width, height] = box.get_size();
        const arrows = [
            this._nextPageArrow,
            this._previousPageArrow,
        ];

        const minArrowsWidth = arrows.reduce(
            (previousWidth, accessory) => {
                const [min] = accessory.get_preferred_width(height);
                return Math.max(previousWidth, min);
            }, 0);

        const idealIndicatorWidth = (width * 0.1/* PAGE_PREVIEW_RATIO*/) / 2;

        return Math.max(idealIndicatorWidth, minArrowsWidth);
    },
};

const FolderIcon = {
    after__init() {
        /* // If folder preview icons are clickable,
        // disable opening the folder with primary mouse button and enable the secondary one
         const buttonMask = opt.APP_GRID_ACTIVE_PREVIEW
            ? St.ButtonMask.TWO | St.ButtonMask.THREE
            : St.ButtonMask.ONE | St.ButtonMask.TWO;
        this.button_mask = buttonMask;*/
        this.button_mask = St.ButtonMask.ONE | St.ButtonMask.TWO;
        if (shellVersion46)
            this.add_style_class_name('app-folder-46');
        else
            this.add_style_class_name('app-folder-45');
    },

    open() {
        this._ensureFolderDialog();
        this._dialog._updateFolderSize();
        // always open folder with the first page
        this.view._scrollView.get_vscroll_bar().adjustment.value = 0;
        this._dialog.popup();
    },
};

const ActiveFolderIcon = {
    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    },

    acceptDrop() {
        return false;
    },

    _onDragEnd() {
        this._dragging = false;
        this.undoScaleAndFade();
        Main.overview.endItemDrag(this._sourceItem.icon);
    },
};

const FolderView = {
    _createGrid() {
        let grid = new FolderGrid();
        return grid;
    },

    createFolderIcon(size) {
        const layout = new Clutter.GridLayout({
            row_homogeneous: true,
            column_homogeneous: true,
        });

        let icon = new St.Widget({
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
            style: `width: ${size}px; height: ${size}px;`,
        });

        const numItems = this._orderedItems.length;
        // decide what number of icons switch to 3x3 grid
        // APP_GRID_FOLDER_ICON_GRID: 3 -> more than 4
        //                          : 4 -> more than 8
        const threshold = opt.APP_GRID_FOLDER_ICON_GRID % 3 ? 8 : 4;
        const gridSize = opt.APP_GRID_FOLDER_ICON_GRID > 2 && numItems > threshold ? 3 : 2;
        const FOLDER_SUBICON_FRACTION = gridSize === 2 ? 0.4 : 0.27;

        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);
        let rtl = icon.get_text_direction() === Clutter.TextDirection.RTL;
        for (let i = 0; i < gridSize * gridSize; i++) {
            const style = `width: ${subSize}px; height: ${subSize}px;`;
            let bin = new St.Bin({ style, reactive: true });
            bin.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });
            if (i < numItems) {
                if (!opt.APP_GRID_ACTIVE_PREVIEW) {
                    bin.child = this._orderedItems[i].app.create_icon_texture(subSize);
                } else {
                    const app = this._orderedItems[i].app;
                    const child = new AppDisplay.AppIcon(app, {
                        setSizeManually: true,
                        showLabel: false,
                    });

                    child._sourceItem = this._orderedItems[i];
                    child._sourceFolder = this;
                    child.icon.style_class = '';
                    child.set_style_class_name('');
                    child.icon.set_style('margin: 0; padding: 0;');
                    child._dot.set_style('margin-bottom: 1px;');
                    child.icon.setIconSize(subSize);

                    bin.child = child;

                    bin.connect('enter-event', () => {
                        bin.ease({
                            duration: 100,
                            translation_y: -3,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    });
                    bin.connect('leave-event', () => {
                        bin.ease({
                            duration: 100,
                            translation_y: 0,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    });
                }
            }

            layout.attach(bin, rtl ? (i + 1) % gridSize : i % gridSize, Math.floor(i / gridSize), 1, 1);
        }

        // if folder content changed, update folder size, but not if it's empty
        /* if (this._dialog && this._dialog._designCapacity !== this._orderedItems.length && this._orderedItems.length)
            this._dialog._updateFolderSize();*/

        return icon;
    },

    _loadApps() {
        this._apps = [];
        const excludedApps = this._folder.get_strv('excluded-apps');
        const appSys = Shell.AppSystem.get_default();
        const addAppId = appId => {
            if (excludedApps.includes(appId))
                return;

            if (opt.APP_GRID_EXCLUDE_FAVORITES && this._appFavorites.isFavorite(appId))
                return;

            const app = appSys.lookup_app(appId);
            if (!app)
                return;

            if (opt.APP_GRID_EXCLUDE_RUNNING) {
                const runningApps = Shell.AppSystem.get_default().get_running().map(a => a.id);
                if (runningApps.includes(appId))
                    return;
            }

            if (!this._parentalControlsManager.shouldShowApp(app.get_app_info()))
                return;

            if (this._apps.indexOf(app) !== -1)
                return;

            this._apps.push(app);
        };

        const folderApps = this._folder.get_strv('apps');
        folderApps.forEach(addAppId);

        const folderCategories = this._folder.get_strv('categories');
        const appInfos = this._parentView.getAppInfos();
        appInfos.forEach(appInfo => {
            let appCategories = /* AppDisplay.*/_getCategories(appInfo);
            if (!_listsIntersect(folderCategories, appCategories))
                return;

            addAppId(appInfo.get_id());
        });

        let items = [];
        this._apps.forEach(app => {
            let icon = this._items.get(app.get_id());
            if (!icon)
                icon = new AppDisplay.AppIcon(app);

            items.push(icon);
        });

        if (opt.APP_FOLDER_ORDER)
            Main.overview._overview.controls._appDisplay._sortOrderedItemsAlphabetically(items);

        if (opt.APP_FOLDER_USAGE)
            items.sort((a, b) => Shell.AppUsage.get_default().compare(a.app.id, b.app.id));

        this._appIds = this._apps.map(app => app.get_id());
        return items;
    },

    // 42 only - don't apply appGrid scale on folders
    adaptToSize(width, height) {
        if (!opt.ORIENTATION) {
            const [, indicatorHeight] = this._pageIndicators.get_preferred_height(-1);
            height -= indicatorHeight;
        }
        BaseAppViewCommon.adaptToSize.bind(this)(width, height, true);
    },

    acceptDrop(source) {
        /* if (!BaseAppViewCommon.acceptDrop.bind(this)(source))
            return false;*/
        if (opt.APP_FOLDER_ORDER)
            return false;
        if (source._sourceItem)
            source = source._sourceItem;

        if (!this._acceptDropCommon(source))
            return false;

        const folderApps = this._orderedItems.map(item => item.id);
        this._folder.set_strv('apps', folderApps);

        return true;
    },
};

const FolderGrid = GObject.registerClass(
class FolderGrid extends AppDisplay.AppGrid {
    _init() {
        super._init({
            allow_incomplete_pages: false,
            columns_per_page: opt.APP_GRID_FOLDER_COLUMNS ? opt.APP_GRID_FOLDER_COLUMNS : 20,
            rows_per_page: opt.APP_GRID_FOLDER_ROWS ? opt.APP_GRID_FOLDER_ROWS : 20,
            page_halign: Clutter.ActorAlign.CENTER,
            page_valign: Clutter.ActorAlign.CENTER,
        });
        this.layout_manager._isFolder = true;
        const spacing = opt.APP_GRID_SPACING;
        this.set_style(`column-spacing: ${spacing}px; row-spacing: ${spacing}px;`);
        this.layoutManager.fixedIconSize = opt.APP_GRID_FOLDER_ICON_SIZE;

        this.setGridModes([
            {
                columns: opt.APP_GRID_FOLDER_COLUMNS ? opt.APP_GRID_FOLDER_COLUMNS : 3,
                rows: opt.APP_GRID_FOLDER_ROWS ? opt.APP_GRID_FOLDER_ROWS : 3,
            },
        ]);
    }

    adaptToSize(width, height) {
        this.layout_manager.adaptToSize(width, height);
    }
});


const FOLDER_DIALOG_ANIMATION_TIME = 200; // AppDisplay.FOLDER_DIALOG_ANIMATION_TIME
const AppFolderDialog = {
    // injection to _init()
    after__init() {
        this._viewBox.add_style_class_name('app-folder-dialog-vshell');
        // GS 46 changed the aligning to CENTER which restricts max folder dialog size
        this._viewBox.set({
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        // delegate this dialog to the FolderIcon._view
        // so its _createFolderIcon function can update the dialog if folder content changed
        this._view._dialog = this;

        // right click into the folder popup should close it
        this.child.reactive = true;
        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', act => {
            if (act.get_button() === Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;
            const [x, y] = clickAction.get_coords();
            const actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            // if it's not entry for editing folder title
            if (actor !== this._entry)
                this.popdown();
            return Clutter.EVENT_STOP;
        });

        this.child.add_action(clickAction);
    },

    after__addFolderNameEntry() {
        // edit-folder-button class has been replaced with icon-button class which is not transparent in 46
        this._editButton.add_style_class_name('edit-folder-button');
        if (shellVersion46)
            this._editButton.add_style_class_name('edit-folder-button-46');

        // Edit button
        this._removeButton = new St.Button({
            style_class: 'icon-button edit-folder-button',
            button_mask: St.ButtonMask.ONE,
            toggle_mode: false,
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                icon_size: 16,
            }),
        });

        this._removeButton.connect('clicked', () => {
            if (Date.now() - this._removeButton._lastClick < Clutter.Settings.get_default().double_click_time) {
                this._grabHelper.ungrab({ actor: this });
                // without hiding the dialog, Shell crashes (at least on X11)
                this.hide();
                this._view._deletingFolder = true;

                // Resetting all keys deletes the relocatable schema
                let keys = this._folder.settings_schema.list_keys();
                for (const key of keys)
                    this._folder.reset(key);

                let settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
                let folders = settings.get_strv('folder-children');
                folders.splice(folders.indexOf(this._view._id), 1);

                // remove all abandoned folders (usually my own garbage and unwanted default folders...)
                /* const appFolders = this._appDisplay._folderIcons.map(icon => icon._id);
                folders.forEach(folder => {
                    if (!appFolders.includes(folder)) {
                        folders.splice(folders.indexOf(folder._id), 1);
                    }
                });*/
                settings.set_strv('folder-children', folders);

                this._view._deletingFolder = false;
                return;
            }
            this._removeButton._lastClick = Date.now();
        });

        this._entryBox.add_child(this._removeButton);

        // Adjust empty actor to center the title
        this._entryBox.get_first_child().width = 82;
    },

    popup() {
        if (this._isOpen)
            return;

        this._isOpen = this._grabHelper.grab({
            actor: this,
            onUngrab: () => this.popdown(),
        });

        if (!this._isOpen)
            return;

        this.get_parent().set_child_above_sibling(this, null);

        this._needsZoomAndFade = true;

        // the first folder dialog realization needs size correction
        // so set the folder size, let it realize and then update the folder content
        if (!this.realized) {
            this._updateFolderSize();
            GLib.idle_add(
                GLib.PRIORITY_DEFAULT,
                () => {
                    this._updateFolderSize();
                }
            );
        }

        this.show();
        this.emit('open-state-changed', true);
    },

    _updateFolderSize() {
        const view = this._view;
        const [firstItem] = view._grid.layoutManager._container;
        if (!firstItem)
            return;
        // adapt folder size according to the settings and number of icons
        const appDisplay = this._source._parentView;
        if (!appDisplay.width || appDisplay.allocation.x2 === Infinity || appDisplay.allocation.x2 === -Infinity) {
            return;
        }

        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        const itemPadding = 55; // default icon item padding on Fedora 44
        // const dialogMargin = 30;
        const nItems = view._orderedItems.length;
        let columns = opt.APP_GRID_FOLDER_COLUMNS;
        let rows = opt.APP_GRID_FOLDER_ROWS;
        const fullAdaptiveGrid = !columns && !rows;
        let spacing = opt.APP_GRID_SPACING;
        const minItemSize = 48 + itemPadding;

        if (fullAdaptiveGrid) {
            columns = Math.ceil(Math.sqrt(nItems));
            rows = columns;
            if (columns * (columns - 1) >= nItems) {
                rows = columns - 1;
            } else if ((columns + 1) * (columns - 1) >= nItems) {
                rows = columns - 1;
                columns += 1;
            }
        } else if (!columns && rows) {
            columns = Math.ceil(nItems / rows);
        } else if (columns && !rows) {
            rows = Math.ceil(nItems / columns);
        }

        const iconSize = opt.APP_GRID_FOLDER_ICON_SIZE < 0 ? opt.APP_GRID_FOLDER_ICON_SIZE_DEFAULT : opt.APP_GRID_FOLDER_ICON_SIZE;
        view._grid.layoutManager.fixedIconSize = iconSize;
        view._grid.set_style(`column-spacing: ${opt.APP_GRID_SPACING}px; row-spacing: ${opt.APP_GRID_SPACING}px;`);
        view._grid.layoutManager._pageWidth += 1;
        view._grid.layoutManager.adaptToSize(view._grid.layoutManager._pageWidth - 1, view._grid.layoutManager._pageHeight);

        let itemSize = iconSize + 55; // icon padding
        // first run sets the grid before we can read the real icon size
        // so we estimate the size from default properties
        // and correct it in the second run
        if (this.realized) {
            firstItem.icon.setIconSize(iconSize);
            const [firstItemWidth] = firstItem.get_preferred_size();
            const realSize = firstItemWidth / scaleFactor;
            // if the preferred item size is smaller than icon plus some padding, ignore it
            // (icons that are not yet realized are returning sizes like 45 or 53)
            if (realSize > (iconSize + 24))
                itemSize = realSize;
        }

        let width = columns * (itemSize + spacing) + /* padding for nav arrows*/64;
        width = Math.round(width + (opt.ORIENTATION ? 100 : 160/* space for navigation arrows*/));
        let height = rows * (itemSize + spacing) + /* header*/75 + /* padding*/ 2 * 30 + /* padding + ?page indicator*/(!opt.ORIENTATION || !opt.APP_GRID_FOLDER_COLUMNS ? 100 : 70);

        // allocation is more reliable than appDisplay width/height properties
        const appDisplayWidth = appDisplay.allocation.x2 - appDisplay.allocation.x1;
        const appDisplayHeight = appDisplay.allocation.y2 - appDisplay.allocation.y1 + (opt.SHOW_SEARCH_ENTRY ? Main.overview._overview.controls._searchEntryBin.height : 0);

        // folder must fit the appDisplay area
        // reduce columns/rows if needed and count with the scaled values
        if (!opt.APP_GRID_FOLDER_ROWS) {
            while ((height * scaleFactor) > appDisplayHeight) {
                height -= itemSize + spacing;
                rows -= 1;
            }
        }

        if (!opt.APP_GRID_FOLDER_COLUMNS) {
            while ((width * scaleFactor) > appDisplayWidth) {
                width -= itemSize + spacing;
                columns -= 1;
            }
        }
        // try to compensate for the previous reduction if there is a space
        if (!opt.APP_GRID_FOLDER_COLUMNS) {
            while ((nItems > columns * rows) && ((width * scaleFactor + itemSize + spacing) <= appDisplayWidth)) {
                width += itemSize + spacing;
                columns += 1;
            }
            // remove columns that cannot be displayed
            if ((columns * minItemSize  + (columns - 1) * spacing) > appDisplayWidth)
                columns = Math.floor(appDisplayWidth / (minItemSize + spacing));
        }
        if (!opt.APP_GRID_FOLDER_ROWS) {
            while ((nItems > columns * rows) && ((height * scaleFactor + itemSize + spacing) <= appDisplayHeight)) {
                height += itemSize + spacing;
                rows += 1;
            }
            // remove rows that cannot be displayed
            if ((rows * minItemSize  + (rows - 1) * spacing) > appDisplayHeight)
                rows = Math.floor(appDisplayWidth / (minItemSize + spacing));
        }

        width = Math.clamp(width, 640, appDisplayWidth);
        height = Math.min(height, appDisplayHeight);

        const layoutManager = view._grid.layoutManager;
        layoutManager.rows_per_page = rows;
        layoutManager.columns_per_page = columns;

        // this line is required by GS 43
        // view._grid.setGridModes([{ columns, rows }]);

        this.child.set_style(`
            width: ${width}px;
            height: ${height}px;
            padding: 30px;
        `);

        view._redisplay();
        // store original item count
        this._designCapacity = nItems;
    },

    _zoomAndFadeIn() {
        let [sourceX, sourceY] =
            this._source.get_transformed_position();
        let [dialogX, dialogY] =
            this.child.get_transformed_position();

        const sourceCenterX = sourceX + this._source.width / 2;
        const sourceCenterY = sourceY + this._source.height / 2;

        // this. covers the whole screen
        let dialogTargetX = dialogX;
        let dialogTargetY = dialogY;

        const appDisplay = this._source._parentView;

        const [appDisplayX, appDisplayY] = this._source._parentView.get_transformed_position();
        if (!opt.APP_GRID_FOLDER_CENTER) {
            dialogTargetX = sourceCenterX - this.child.width / 2;
            dialogTargetY = sourceCenterY - this.child.height / 2;

            // keep the dialog in appDisplay area if possible
            dialogTargetX = Math.clamp(
                dialogTargetX,
                appDisplayX,
                appDisplayX + appDisplay.width - this.child.width
            );

            dialogTargetY = Math.clamp(
                dialogTargetY,
                appDisplayY,
                appDisplayY + appDisplay.height - this.child.height
            );
        } else {
            const searchEntryHeight = opt.SHOW_SEARCH_ENTRY ? Main.overview._overview.controls._searchEntryBin.height : 0;
            dialogTargetX = appDisplayX + appDisplay.width / 2 - this.child.width / 2;
            dialogTargetY = appDisplayY - searchEntryHeight + ((appDisplay.height + searchEntryHeight) / 2 - this.child.height / 2) / 2;
        }

        const dialogOffsetX = Math.round(dialogTargetX - dialogX);
        const dialogOffsetY = Math.round(dialogTargetY - dialogY);

        this.child.set({
            translation_x: sourceX - dialogX,
            translation_y: sourceY - dialogY,
            scale_x: this._source.width / this.child.width,
            scale_y: this._source.height / this.child.height,
            opacity: 0,
        });

        this.child.ease({
            translation_x: dialogOffsetX,
            translation_y: dialogOffsetY,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        appDisplay.ease({
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (opt.SHOW_SEARCH_ENTRY) {
            Main.overview.searchEntry.ease({
                opacity: 0,
                duration: FOLDER_DIALOG_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._needsZoomAndFade = false;

        if (this._sourceMappedId === 0) {
            this._sourceMappedId = this._source.connect(
                'notify::mapped', this._zoomAndFadeOut.bind(this));
        }
    },

    _zoomAndFadeOut() {
        if (!this._isOpen)
            return;

        if (!this._source.mapped) {
            this.hide();
            return;
        }

        // if the dialog was shown silently, skip animation
        if (this.scale_y < 1) {
            this._needsZoomAndFade = false;
            this.hide();
            this._popdownCallbacks.forEach(func => func());
            this._popdownCallbacks = [];
            return;
        }

        let [sourceX, sourceY] =
            this._source.get_transformed_position();
        let [dialogX, dialogY] =
            this.child.get_transformed_position();

        this.child.ease({
            translation_x: sourceX - dialogX + this.child.translation_x,
            translation_y: sourceY - dialogY + this.child.translation_y,
            scale_x: this._source.width / this.child.width,
            scale_y: this._source.height / this.child.height,
            opacity: 0,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.child.set({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                });
                this.hide();

                this._popdownCallbacks.forEach(func => func());
                this._popdownCallbacks = [];
            },
        });

        const appDisplay = this._source._parentView;
        appDisplay.ease({
            opacity: 255,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (opt.SHOW_SEARCH_ENTRY) {
            Main.overview.searchEntry.ease({
                opacity: 255,
                duration: FOLDER_DIALOG_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._needsZoomAndFade = false;
    },

    _setLighterBackground(lighter) {
        if (this._isOpen)
            Main.overview._overview._controls._appDisplay.opacity = lighter ? 20 : 0;
        /* const backgroundColor = lighter
            ? this.DIALOG_SHADE_HIGHLIGHT
            : this.DIALOG_SHADE_NORMAL;

        this.ease({
            backgroundColor,
            duration: FOLDER_DIALOG_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        }); */
    },
};

const AppIcon = {
    after__init() {
        // update the app label behavior
        this._updateMultiline();
    },

    // avoid accepting by placeholder when dragging active preview
    // and also by icon if alphabet or usage sorting are used
    _canAccept(source) {
        if (source._sourceItem)
            source = source._sourceItem;
        let view = /* AppDisplay.*/_getViewFromIcon(source);

        return source !== this &&
               (source instanceof this.constructor) &&
               (view instanceof AppDisplay.AppDisplay &&
                !opt.APP_GRID_USAGE);
    },
};

const AppViewItemCommon = {
    _updateMultiline() {
        const { label } = this.icon;
        if (label)
            label.opacity = 255;
        if (!this._expandTitleOnHover || !this.icon.label)
            return;

        const { clutterText } = label;

        const isHighlighted = this.has_key_focus() || this.hover || this._forcedHighlight;

        if (opt.APP_GRID_NAMES_MODE === 2 && this._expandTitleOnHover) { // !_expandTitleOnHover indicates search result icon
            label.opacity = isHighlighted || !this.app ? 255 : 0;
        }
        if (isHighlighted)
            this.get_parent()?.set_child_above_sibling(this, null);

        if (!opt.APP_GRID_NAMES_MODE) {
            const layout = clutterText.get_layout();
            if (!layout.is_wrapped() && !layout.is_ellipsized())
                return;
        }

        label.remove_transition('allocation');

        const id = label.connect('notify::allocation', () => {
            label.restore_easing_state();
            label.disconnect(id);
        });

        const expand = opt.APP_GRID_NAMES_MODE === 1 || this._forcedHighlight || this.hover || this.has_key_focus();

        label.save_easing_state();
        label.set_easing_duration(expand
            ? APP_ICON_TITLE_EXPAND_TIME
            : APP_ICON_TITLE_COLLAPSE_TIME);
        clutterText.set({
            line_wrap: expand,
            line_wrap_mode: expand ? Pango.WrapMode.WORD_CHAR : Pango.WrapMode.NONE,
            ellipsize: expand ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END,
        });
    },

    // support active preview icons
    acceptDrop(source, _actor, x) {
        if (opt.APP_GRID_USAGE)
            return DND.DragMotionResult.NO_DROP;

        this._setHoveringByDnd(false);

        if (!this._canAccept(source))
            return false;

        if (this._withinLeeways(x))
            return false;

        // added - remove app from the source folder after dnd to other folder
        if (source._sourceItem) {
            const app = source._sourceItem.app;
            source._sourceFolder.removeApp(app);
        }

        return true;
    },

};
