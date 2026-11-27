/* shell-lamp-effect.h
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#pragma once

#include <clutter/clutter.h>
#include <st/st.h>

G_BEGIN_DECLS

#define SHELL_TYPE_LAMP_EFFECT (shell_lamp_effect_get_type ())
G_DECLARE_FINAL_TYPE (ShellLampEffect, shell_lamp_effect, SHELL, LAMP_EFFECT, ClutterOffscreenEffect)

ShellLampEffect *shell_lamp_effect_new (void);

void shell_lamp_effect_set_target (ShellLampEffect *self,
                                   StSide           side,
                                   float            x,
                                   float            y,
                                   float            width,
                                   float            height);

G_END_DECLS
