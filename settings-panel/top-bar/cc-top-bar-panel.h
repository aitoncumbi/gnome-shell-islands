/* SPDX-License-Identifier: GPL-2.0-or-later */

#pragma once

#include <shell/cc-panel.h>

G_BEGIN_DECLS

#define CC_TYPE_TOP_BAR_PANEL (cc_top_bar_panel_get_type ())
G_DECLARE_FINAL_TYPE (CcTopBarPanel, cc_top_bar_panel, CC, TOP_BAR_PANEL, CcPanel);

G_END_DECLS
