"""Jinja2 rendering of the model into a multi-page static site."""
import os
import shutil

from jinja2 import Environment, FileSystemLoader


def build_env(root):
    return Environment(
        loader=FileSystemLoader(os.path.join(root, "templates")),
        autoescape=True,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def fragment_html(env, ds_view, fmt_view, asset_prefix):
    """The one format block, rendered by the same partial the page uses."""
    template = env.get_template("_format_block.html.j2")
    return template.render(ds=ds_view, fv=fmt_view, asset_prefix=asset_prefix)


def render_site(model, root, out_dir):
    env = build_env(root)
    tech_dir = os.path.join(out_dir, "tech")
    if not os.path.isdir(tech_dir):
        os.makedirs(tech_dir)
    jobs = [
        ("index.html.j2", os.path.join(out_dir, "index.html"),
         {"model": model, "asset_prefix": ""}),
        ("ecs.html.j2", os.path.join(out_dir, "ecs-index.html"),
         {"model": model, "asset_prefix": ""}),
        ("picker.html.j2", os.path.join(out_dir, "picker.html"),
         {"model": model, "asset_prefix": ""}),
    ]
    for view in model["technologies"]:
        if view["doc"]:
            jobs.append(("tech.html.j2",
                         os.path.join(tech_dir,
                                      view["entry"]["id"] + ".html"),
                         {"model": model, "view": view,
                          "asset_prefix": "../"}))
    for template_name, path, ctx in jobs:
        html = env.get_template(template_name).render(**ctx)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(html)
    for name in ("styles.css", "app.js"):
        shutil.copy(os.path.join(root, "static", name), out_dir)
    picker_src = os.path.join(root, "static", "picker")
    picker_dst = os.path.join(out_dir, "picker")
    if not os.path.isdir(picker_dst):
        os.makedirs(picker_dst)
    for name in sorted(os.listdir(picker_src)):
        if name.endswith(".js"):
            shutil.copy(os.path.join(picker_src, name), picker_dst)
