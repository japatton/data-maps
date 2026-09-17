(function () {
  "use strict";
  var searches = document.querySelectorAll("input.js-search");
  var buttons = document.querySelectorAll("#filter-row button[data-filter-group]");
  var active = {};
  // Row filters run on every row of a searchable table and can veto it;
  // the ECS page registers one that filters the usage chips inside a row
  // and hides the row when the filters leave it with nothing to show.
  var rowFilters = [];
  var afterApply = [];

  function rowsFor(targetId) {
    var body = document.getElementById(targetId);
    return body ? body.getElementsByTagName("tr") : [];
  }

  function applyAll() {
    for (var s = 0; s < searches.length; s++) {
      var input = searches[s];
      var query = input.value.toLowerCase();
      var rows = rowsFor(input.getAttribute("data-target"));
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var visible = true;
        if (query &&
            (row.getAttribute("data-search") || "").indexOf(query) === -1) {
          visible = false;
        }
        for (var group in active) {
          if (active[group] &&
              row.getAttribute("data-" + group) !== active[group]) {
            visible = false;
          }
        }
        for (var f = 0; f < rowFilters.length; f++) {
          if (!rowFilters[f](row)) {
            visible = false;
          }
        }
        row.style.display = visible ? "" : "none";
      }
    }
    for (var a = 0; a < afterApply.length; a++) {
      afterApply[a]();
    }
  }

  function onFilterClick() {
    var group = this.getAttribute("data-filter-group");
    active[group] = this.getAttribute("data-filter-value");
    for (var j = 0; j < buttons.length; j++) {
      if (buttons[j].getAttribute("data-filter-group") === group) {
        buttons[j].classList.remove("active");
      }
    }
    this.classList.add("active");
    applyAll();
  }

  var catalog = document.getElementById("catalog-rows");
  var filterRow = document.getElementById("filter-row");
  if (catalog && filterRow) {
    var seen = {};
    var rows = catalog.getElementsByTagName("tr");
    for (var r = 0; r < rows.length; r++) {
      var cat = rows[r].getAttribute("data-category");
      if (cat && !seen[cat]) {
        seen[cat] = true;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("data-filter-group", "category");
        btn.setAttribute("data-filter-value", cat);
        btn.appendChild(document.createTextNode(cat));
        filterRow.insertBefore(btn,
            filterRow.querySelector("input.js-search"));
      }
    }
    buttons = document.querySelectorAll(
        "#filter-row button[data-filter-group]");
  }

  for (var b = 0; b < buttons.length; b++) {
    buttons[b].addEventListener("click", onFilterClick);
  }
  for (var t = 0; t < searches.length; t++) {
    searches[t].addEventListener("input", applyAll);
  }

  // ECS index page: the field table carries a usage chip for every format
  // of every dataset, so it opens showing the recommended formats only and
  // the category/status buttons filter the chips, not the rows. A row left
  // with no visible chip has nothing to say and is hidden with them.
  var ecsBody = document.getElementById("ecs-rows");
  if (ecsBody) {
    var usageActive = {"category": "", "status": ""};
    var recommendedOnly = true;
    var counter = document.getElementById("ecs-row-count");
    var ecsRows = ecsBody.getElementsByTagName("tr");
    for (var er = 0; er < ecsRows.length; er++) {
      ecsRows[er].usageChips =
          ecsRows[er].querySelectorAll("a.usage-chip");
    }

    var chipVisible = function (chip) {
      if (recommendedOnly &&
          chip.getAttribute("data-recommended") !== "1") {
        return false;
      }
      if (usageActive.status &&
          chip.getAttribute("data-status") !== usageActive.status) {
        return false;
      }
      if (usageActive.category) {
        // A dataset can serve several alerting categories; the attribute
        // is a space-separated list and any member is a match.
        var list = " " + (chip.getAttribute("data-category") || "") + " ";
        if (list.indexOf(" " + usageActive.category + " ") === -1) {
          return false;
        }
      }
      return true;
    };

    rowFilters.push(function (row) {
      var chips = row.usageChips;
      if (!chips || !chips.length) { return true; }
      var kept = false;
      for (var i = 0; i < chips.length; i++) {
        var show = chipVisible(chips[i]);
        chips[i].style.display = show ? "" : "none";
        if (show) { kept = true; }
      }
      return kept;
    });

    if (counter) {
      afterApply.push(function () {
        var shown = 0;
        for (var i = 0; i < ecsRows.length; i++) {
          if (ecsRows[i].style.display !== "none") { shown++; }
        }
        counter.innerHTML = "";
        counter.appendChild(document.createTextNode(
            shown + " of " + ecsRows.length + " fields shown"));
      });
    }

    var usageButtons = document.querySelectorAll(
        "#filter-row button[data-usage-group]");
    var onUsageClick = function () {
      var group = this.getAttribute("data-usage-group");
      usageActive[group] = this.getAttribute("data-filter-value");
      for (var i = 0; i < usageButtons.length; i++) {
        if (usageButtons[i].getAttribute("data-usage-group") === group) {
          usageButtons[i].classList.remove("active");
        }
      }
      this.classList.add("active");
      applyAll();
    };
    for (var ub = 0; ub < usageButtons.length; ub++) {
      usageButtons[ub].addEventListener("click", onUsageClick);
    }

    var recToggle = document.getElementById("recommended-only");
    if (recToggle) {
      recToggle.addEventListener("click", function () {
        recommendedOnly = !recommendedOnly;
        if (recommendedOnly) {
          recToggle.classList.add("active");
        } else {
          recToggle.classList.remove("active");
        }
        recToggle.setAttribute("aria-pressed",
            recommendedOnly ? "true" : "false");
        applyAll();
      });
    }
    applyAll();
  }

  var page = document.getElementById("tech-page");
  if (page) {
    var sideButtons = document.querySelectorAll(
        "#side-toggle button[data-side]");
    var setSide = function (side) {
      page.className = "side-" + side;
      for (var i = 0; i < sideButtons.length; i++) {
        if (sideButtons[i].getAttribute("data-side") === side) {
          sideButtons[i].classList.add("active");
        } else {
          sideButtons[i].classList.remove("active");
        }
      }
      try { localStorage.setItem("datamaps-side", side); } catch (e) {}
    };
    for (var sb = 0; sb < sideButtons.length; sb++) {
      sideButtons[sb].addEventListener("click", function () {
        setSide(this.getAttribute("data-side"));
      });
    }
    var savedSide = null;
    try { savedSide = localStorage.getItem("datamaps-side"); } catch (e) {}
    if (savedSide === "direct") { setSide("direct"); }

    var switches = document.querySelectorAll(".format-switch");
    for (var fs = 0; fs < switches.length; fs++) {
      (function (sw) {
        var section = sw.parentNode;
        var fmtButtons = sw.querySelectorAll("button[data-format]");
        var pick = function () {
          var fmt = this.getAttribute("data-format");
          var variants = section.querySelectorAll(".format-variant");
          for (var v = 0; v < variants.length; v++) {
            if (variants[v].getAttribute("data-format") === fmt) {
              variants[v].classList.add("active");
            } else {
              variants[v].classList.remove("active");
            }
          }
          for (var b = 0; b < fmtButtons.length; b++) {
            if (fmtButtons[b] === this) {
              fmtButtons[b].classList.add("active");
            } else {
              fmtButtons[b].classList.remove("active");
            }
          }
        };
        for (var fb = 0; fb < fmtButtons.length; fb++) {
          fmtButtons[fb].addEventListener("click", pick);
        }
      })(switches[fs]);
    }
  }
})();
