subdir('misc')
subdir('dbusServices')

# a program of its own that the global menu runs
install_data(
  'menuScanner/accessibility.js',
  'menuScanner/dbus.js',
  'menuScanner/electron.js',
  'menuScanner/evaluator.js',
  'menuScanner/main.js',
  'menuScanner/source.js',
  install_dir: pkgdatadir / 'menu-scanner',
)

js_resources = gnome.compile_resources(
  'js-resources', 'js-resources.gresource.xml',
  source_dir: ['.', meson.current_build_dir()],
  c_name: 'shell_js_resources',
  dependencies: [config_js]
)

if have_portal_helper
  portal_resources = gnome.compile_resources(
    'portal-resources', 'portal-resources.gresource.xml',
    source_dir: ['.', meson.current_build_dir()],
    c_name: 'portal_js_resources',
    dependencies: [config_js]
  )
endif
