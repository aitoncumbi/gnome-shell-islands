/* shell-lamp-effect.c
 *
 * Bends an actor into a funnel and pours it into a small rectangle, like a
 * genie going back into its lamp.
 *
 * This draws its own mesh, since ClutterDeformEffect does not draw anything with
 * every renderer.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#include "config.h"

#include "shell-lamp-effect.h"

#include <math.h>

/* The bend shows along the way to the target, so that is where the mesh has to
 * be fine. Across it, the rows only get narrower.
 */
#define TILES_ALONG 64
#define TILES_ACROSS 8
#define N_VERTICES ((TILES_ALONG + 1) * (TILES_ACROSS + 1))
#define N_INDICES (TILES_ALONG * TILES_ACROSS * 6)

/* The first part of the animation forms the funnel, the rest pours the actor
 * down. They overlap, so that neither seems to wait for the other.
 */
#define BEND_END 0.6f
#define POUR_START 0.22f

struct _ShellLampEffect
{
  ClutterOffscreenEffect parent_instance;

  CoglIndices *indices;

  float progress;

  StSide side;
  graphene_rect_t target;
};

G_DEFINE_FINAL_TYPE (ShellLampEffect, shell_lamp_effect, CLUTTER_TYPE_OFFSCREEN_EFFECT)

enum
{
  PROP_0,
  PROP_PROGRESS,
  N_PROPS
};

static GParamSpec *properties[N_PROPS];

static inline float
mix (float a,
     float b,
     float t)
{
  return a + (b - a) * t;
}

static inline float
smoothstep (float edge0,
            float edge1,
            float x)
{
  float t = CLAMP ((x - edge0) / (edge1 - edge0), 0.0f, 1.0f);

  return t * t * (3.0f - 2.0f * t);
}

/* Starts and ends with neither speed nor acceleration */
static inline float
smootherstep (float edge0,
              float edge1,
              float x)
{
  float t = CLAMP ((x - edge0) / (edge1 - edge0), 0.0f, 1.0f);

  return t * t * t * (t * (t * 6.0f - 15.0f) + 10.0f);
}

typedef struct
{
  float length, breadth;
  float target_distance, target_start, target_end;
  float bend;
  float near_edge, far_edge;
} Funnel;

static void
compute_funnel (ShellLampEffect *self,
                float            width,
                float            height,
                Funnel          *funnel)
{
  float center, pour;

  switch (self->side)
    {
    case ST_SIDE_TOP:
    case ST_SIDE_BOTTOM:
    default:
      center = self->target.origin.y + self->target.size.height / 2.0f;
      funnel->length = height;
      funnel->breadth = width;
      funnel->target_distance =
        self->side == ST_SIDE_TOP ? height - center : center;
      funnel->target_start = self->target.origin.x;
      funnel->target_end = funnel->target_start + self->target.size.width;
      break;
    case ST_SIDE_LEFT:
    case ST_SIDE_RIGHT:
      center = self->target.origin.x + self->target.size.width / 2.0f;
      funnel->length = width;
      funnel->breadth = height;
      funnel->target_distance =
        self->side == ST_SIDE_LEFT ? width - center : center;
      funnel->target_start = self->target.origin.y;
      funnel->target_end = funnel->target_start + self->target.size.height;
      break;
    }

  /* The target can be behind the actor if that is partly off the screen */
  funnel->target_distance = MAX (funnel->target_distance, 1.0f);

  funnel->bend = smootherstep (0.0f, BEND_END, self->progress);
  pour = smoothstep (POUR_START, 1.0f, self->progress);

  /* The edge that faces the target reaches for it first, and the other edge
   * follows
   */
  funnel->near_edge = mix (funnel->length, funnel->target_distance, funnel->bend);
  funnel->far_edge = funnel->target_distance * pour;
}

/* v runs along the way to the target, u across it */
static void
compute_vertex (ShellLampEffect *self,
                const Funnel    *funnel,
                float            u,
                float            v,
                CoglVertexP2T2  *vertex)
{
  float distance, narrowing, across;

  distance = mix (funnel->far_edge, funnel->near_edge, v);

  /* The walls of the funnel: half a wave from the edges of the actor to those
   * of the target
   */
  narrowing = CLAMP (distance / funnel->target_distance, 0.0f, 1.0f);
  narrowing = 0.5f - 0.5f * cosf (narrowing * (float) G_PI);

  across = mix (u * funnel->breadth,
                mix (funnel->target_start, funnel->target_end, u),
                narrowing * funnel->bend);

  switch (self->side)
    {
    case ST_SIDE_TOP:
      *vertex = (CoglVertexP2T2) { across, funnel->length - distance, u, 1.0f - v };
      break;
    case ST_SIDE_LEFT:
      *vertex = (CoglVertexP2T2) { funnel->length - distance, across, 1.0f - v, u };
      break;
    case ST_SIDE_RIGHT:
      *vertex = (CoglVertexP2T2) { distance, across, v, u };
      break;
    case ST_SIDE_BOTTOM:
    default:
      *vertex = (CoglVertexP2T2) { across, distance, u, v };
      break;
    }
}

static CoglPrimitive *
create_primitive (ShellLampEffect *self,
                  CoglContext     *ctx,
                  float            width,
                  float            height,
                  float            scale_x,
                  float            scale_y)
{
  CoglVertexP2T2 vertices[N_VERTICES];
  CoglPrimitive *primitive;
  Funnel funnel;
  int i = 0;

  compute_funnel (self, width, height, &funnel);

  for (int y = 0; y <= TILES_ALONG; y++)
    {
      for (int x = 0; x <= TILES_ACROSS; x++, i++)
        {
          compute_vertex (self, &funnel,
                          (float) x / TILES_ACROSS,
                          (float) y / TILES_ALONG,
                          &vertices[i]);
          vertices[i].x *= scale_x;
          vertices[i].y *= scale_y;
        }
    }

  if (!self->indices)
    {
      uint16_t indices[N_INDICES];

      i = 0;
      for (int y = 0; y < TILES_ALONG; y++)
        {
          for (int x = 0; x < TILES_ACROSS; x++)
            {
              uint16_t top = y * (TILES_ACROSS + 1) + x;
              uint16_t bottom = top + TILES_ACROSS + 1;

              indices[i++] = top;
              indices[i++] = bottom;
              indices[i++] = top + 1;
              indices[i++] = top + 1;
              indices[i++] = bottom;
              indices[i++] = bottom + 1;
            }
        }

      self->indices = cogl_indices_new (ctx,
                                        COGL_INDICES_TYPE_UNSIGNED_SHORT,
                                        indices, N_INDICES);
    }

  primitive = cogl_primitive_new_p2t2 (ctx, COGL_VERTICES_MODE_TRIANGLES,
                                       N_VERTICES, vertices);
  cogl_primitive_set_indices (primitive, self->indices, N_INDICES);

  return primitive;
}

static void
shell_lamp_effect_paint_target (ClutterOffscreenEffect *effect,
                                ClutterPaintNode       *node,
                                ClutterPaintContext    *paint_context)
{
  ShellLampEffect *self = SHELL_LAMP_EFFECT (effect);
  ClutterActor *actor =
    clutter_actor_meta_get_actor (CLUTTER_ACTOR_META (effect));
  CoglPipeline *pipeline = clutter_offscreen_effect_get_pipeline (effect);
  CoglTexture *texture = clutter_offscreen_effect_get_texture (effect);
  g_autoptr (ClutterPaintNode) pipeline_node = NULL;
  g_autoptr (CoglPrimitive) primitive = NULL;
  float width, height, opacity;
  CoglColor color;

  clutter_actor_get_size (actor, &width, &height);
  if (!pipeline || !texture || width < 1.0f || height < 1.0f)
    return;

  opacity = clutter_actor_get_paint_opacity (actor) / 255.0f;
  cogl_color_init_from_4f (&color, opacity, opacity, opacity, opacity);
  cogl_pipeline_set_color (pipeline, &color);

  /* The target is in actor coordinates, this paints in pixels of the texture */
  primitive = create_primitive (self,
                                cogl_texture_get_context (texture),
                                width, height,
                                cogl_texture_get_width (texture) / width,
                                cogl_texture_get_height (texture) / height);

  pipeline_node = clutter_pipeline_node_new (pipeline);
  clutter_paint_node_set_static_name (pipeline_node, "ShellLampEffect");
  clutter_paint_node_add_primitive (pipeline_node, primitive);
  clutter_paint_node_add_child (node, pipeline_node);
}

static gboolean
shell_lamp_effect_modify_paint_volume (ClutterEffect      *effect,
                                       ClutterPaintVolume *volume)
{
  /* Paints anywhere between the actor and its target */
  return FALSE;
}

static void
shell_lamp_effect_get_property (GObject    *object,
                                guint       prop_id,
                                GValue     *value,
                                GParamSpec *pspec)
{
  ShellLampEffect *self = SHELL_LAMP_EFFECT (object);

  switch (prop_id)
    {
    case PROP_PROGRESS:
      g_value_set_float (value, self->progress);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
shell_lamp_effect_set_property (GObject      *object,
                                guint         prop_id,
                                const GValue *value,
                                GParamSpec   *pspec)
{
  ShellLampEffect *self = SHELL_LAMP_EFFECT (object);

  switch (prop_id)
    {
    case PROP_PROGRESS:
      if (self->progress != g_value_get_float (value))
        {
          self->progress = g_value_get_float (value);
          clutter_effect_queue_repaint (CLUTTER_EFFECT (self));
          g_object_notify_by_pspec (object, pspec);
        }
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static void
shell_lamp_effect_finalize (GObject *object)
{
  ShellLampEffect *self = SHELL_LAMP_EFFECT (object);

  g_clear_object (&self->indices);

  G_OBJECT_CLASS (shell_lamp_effect_parent_class)->finalize (object);
}

static void
shell_lamp_effect_class_init (ShellLampEffectClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);
  ClutterEffectClass *effect_class = CLUTTER_EFFECT_CLASS (klass);
  ClutterOffscreenEffectClass *offscreen_class =
    CLUTTER_OFFSCREEN_EFFECT_CLASS (klass);

  object_class->finalize = shell_lamp_effect_finalize;
  object_class->get_property = shell_lamp_effect_get_property;
  object_class->set_property = shell_lamp_effect_set_property;

  effect_class->modify_paint_volume = shell_lamp_effect_modify_paint_volume;

  offscreen_class->paint_target = shell_lamp_effect_paint_target;

  /**
   * ShellLampEffect:progress:
   *
   * How far the actor is on its way: 0 is in place, 1 is in the target.
   */
  properties[PROP_PROGRESS] =
    g_param_spec_float ("progress", NULL, NULL,
                        0.0f, 1.0f, 0.0f,
                        G_PARAM_READWRITE |
                        G_PARAM_STATIC_STRINGS |
                        G_PARAM_EXPLICIT_NOTIFY);

  g_object_class_install_properties (object_class, N_PROPS, properties);
}

static void
shell_lamp_effect_init (ShellLampEffect *self)
{
  self->side = ST_SIDE_BOTTOM;
  graphene_rect_init (&self->target, 0, 0, 0, 0);
}

ShellLampEffect *
shell_lamp_effect_new (void)
{
  return g_object_new (SHELL_TYPE_LAMP_EFFECT, NULL);
}

/**
 * shell_lamp_effect_set_target:
 * @self: a #ShellLampEffect
 * @side: the side of the actor that the target is at
 * @x: left edge of the target, in actor coordinates
 * @y: top edge of the target, in actor coordinates
 * @width: width of the target
 * @height: height of the target
 *
 * Sets the rectangle that the actor disappears into.
 */
void
shell_lamp_effect_set_target (ShellLampEffect *self,
                              StSide           side,
                              float            x,
                              float            y,
                              float            width,
                              float            height)
{
  g_return_if_fail (SHELL_IS_LAMP_EFFECT (self));

  self->side = side;
  graphene_rect_init (&self->target, x, y, width, height);

  clutter_effect_queue_repaint (CLUTTER_EFFECT (self));
}
