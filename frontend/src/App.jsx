import { useCallback, useEffect, useState } from "react";
import "./App.css";

function App() {
  const [plans, setPlans] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [remindersError, setRemindersError] = useState("");
  const [reminderServiceFilter, setReminderServiceFilter] = useState("");
  const [reminderTypeFilter, setReminderTypeFilter] = useState("");
  const [reminderSearchText, setReminderSearchText] = useState("");
  const [searchText, setSearchText] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedRenewal, setSelectedRenewal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editPlan, setEditPlan] = useState(null);

  const [rechargePlan, setRechargePlan] = useState(null);

  const [historyPlan, setHistoryPlan] = useState(null);
const [rechargeHistory, setRechargeHistory] = useState([]);

const [rechargeData, setRechargeData] = useState({
  recharge_date: "",
  expiry_date: "",
  amount: "",
  notes: "",
});

  const [formData, setFormData] = useState({
    service: "",
    plan_name: "",
    category: "",
    recharge_date: "",
    expiry_date: "",
    frequency: "",
    amount: "",
    notes: "",
  });

  const reminderServices = [...new Set(
    reminders.map((reminder) => reminder.service).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  const filteredReminders = reminders.filter((reminder) => {
    const matchesService = !reminderServiceFilter || reminder.service === reminderServiceFilter;
    const matchesType = !reminderTypeFilter || reminder.reminder_type === reminderTypeFilter;
    const matchesSearch = String(reminder.plan_name || "")
      .toLowerCase()
      .includes(reminderSearchText.trim().toLowerCase());

    return matchesService && matchesType && matchesSearch;
  });

  const normalizedSearch = searchText.trim().toLowerCase();
  const filteredPlans = plans.filter((plan) => {
    const matchesSearch = [plan.service, plan.plan_name, plan.category, plan.notes]
      .some((value) => String(value || "").toLowerCase().includes(normalizedSearch));
    const matchesService = !serviceFilter || plan.service === serviceFilter;
    const matchesStatus = !statusFilter || plan.status === statusFilter;

    return matchesSearch && matchesService && matchesStatus;
  });

  const planStats = [
    { label: "Total Plans", status: null, className: "stat-total" },
    { label: "Active", status: "ACTIVE", className: "stat-active" },
    { label: "Due in 7 Days", status: "UPCOMING", className: "stat-upcoming" },
    { label: "Due in 3 Days", status: "DUE SOON", className: "stat-due-soon" },
    { label: "Due Today", status: "DUE TODAY", className: "stat-due-today" },
    { label: "Expired", status: "EXPIRED", className: "stat-expired" },
    { label: "Update Required", status: "UPDATE REQUIRED", className: "stat-update-required" },
  ];

  const serviceStats = Object.entries(
    plans.reduce((counts, plan) => {
      const service = String(plan.service || "").trim();
      if (service) {
        counts[service] = (counts[service] || 0) + 1;
      }
      return counts;
    }, {})
  );

  const attentionStatuses = new Set([
    "UPCOMING",
    "DUE SOON",
    "DUE TODAY",
    "EXPIRED",
    "UPDATE REQUIRED",
  ]);
  const upcomingRenewals = Array.from(
    new Map(
      plans
        .filter((plan) => attentionStatuses.has(plan.status))
        .map((plan) => [plan.id, plan])
    ).values()
  ).sort((a, b) => {
    const aDays = Number.isFinite(a.days_remaining)
      ? a.days_remaining
      : Number.POSITIVE_INFINITY;
    const bDays = Number.isFinite(b.days_remaining)
      ? b.days_remaining
      : Number.POSITIVE_INFINITY;

    return aDays - bDays;
  });

  const formatDaysRemaining = (plan) => {
    if (!Number.isFinite(plan.days_remaining)) return "Not available";
    if (plan.days_remaining === 0) return "Expires today";
    if (plan.days_remaining < 0) {
      const daysExpired = Math.abs(plan.days_remaining);
      return `${daysExpired} day${daysExpired === 1 ? "" : "s"} expired`;
    }
    return `${plan.days_remaining} day${plan.days_remaining === 1 ? "" : "s"} remaining`;
  };

  const clearFilters = () => {
    setSearchText("");
    setServiceFilter("");
    setStatusFilter("");
  };

  const clearReminderFilters = () => {
    setReminderServiceFilter("");
    setReminderTypeFilter("");
    setReminderSearchText("");
  };

  const exportReminderHistory = () => {
    if (filteredReminders.length === 0) return;

    const csvValue = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [
      ["Service", "Plan Name", "Reminder Type", "Expiry Date", "Created At"],
      ...filteredReminders.map((reminder) => [
        reminder.service,
        reminder.plan_name,
        reminder.reminder_type,
        reminder.expiry_date,
        reminder.created_at,
      ]),
    ];
    const csvContent = `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}`;
    const file = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const downloadUrl = window.URL.createObjectURL(file);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = "reminder_history.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
  };

  const exportPlansCsv = () => {
    if (filteredPlans.length === 0) return;

    const csvValue = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = [
      [
        "Service",
        "Plan Name",
        "Category",
        "Recharge Date",
        "Expiry Date",
        "Frequency",
        "Amount",
        "Status",
        "Days Remaining",
        "Notes",
      ],
      ...filteredPlans.map((plan) => [
        plan.service,
        plan.plan_name,
        plan.category,
        plan.recharge_date,
        plan.expiry_date,
        plan.frequency,
        plan.amount,
        plan.status,
        plan.days_remaining,
        plan.notes,
      ]),
    ];
    const csvContent = `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}`;
    const file = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const downloadUrl = window.URL.createObjectURL(file);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = "plans.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
  };

  const revealRenewalPlan = (plan) => {
    setSearchText("");
    setServiceFilter(plan.service || "");
    setStatusFilter(plan.status || "");
    setSelectedRenewal({ planId: plan.id });
  };

  // -----------------------------
  // GET PLANS
  // -----------------------------

  const fetchPlans = useCallback(async () => {
    try {
      const response = await fetch("http://127.0.0.1:5000/plans");

      const data = await response.json();

      setPlans(data);
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReminders = useCallback(async () => {
    setRemindersLoading(true);
    setRemindersError("");

    try {
      const response = await fetch("http://127.0.0.1:5000/reminders");
      if (!response.ok) {
        throw new Error("Failed to load reminder history");
      }

      const data = await response.json();
      setReminders(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Reminder history error:", error);
      setRemindersError("Unable to load reminder history.");
    } finally {
      setRemindersLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlans();
    const refreshIntervalId = window.setInterval(fetchPlans, 5 * 60 * 1000);

    return () => window.clearInterval(refreshIntervalId);
  }, [fetchPlans]);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  useEffect(() => {
    if (!selectedRenewal) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      const planCard = document.getElementById(
        `plan-card-${selectedRenewal.planId}`
      );
      planCard?.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    const timeoutId = window.setTimeout(() => {
      setSelectedRenewal((current) =>
        current === selectedRenewal ? null : current
      );
    }, 3500);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [selectedRenewal]);

  // -----------------------------
  // HANDLE INPUT
  // -----------------------------

  const handleChange = (event) => {
    const { name, value } = event.target;

    setFormData({
      ...formData,
      [name]: value,
    });
  };

  // -----------------------------
  // ADD PLAN
  // -----------------------------

  const handleSubmit = async (event) => {
  event.preventDefault();

  try {
    const url = editPlan
      ? `http://127.0.0.1:5000/plans/${editPlan.id}`
      : "http://127.0.0.1:5000/plans";

    const method = editPlan ? "PUT" : "POST";

    const response = await fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...formData,
        amount: Number(formData.amount),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Failed to save plan");
      return;
    }

    alert(
      editPlan
        ? "Plan updated successfully!"
        : "Plan added successfully!"
    );

    setFormData({
      service: "",
      plan_name: "",
      category: "",
      recharge_date: "",
      expiry_date: "",
      frequency: "",
      amount: "",
      notes: "",
    });

    setEditPlan(null);
    setShowForm(false);

    fetchPlans();

  } catch (error) {
    console.error("Error:", error);
    alert("Cannot connect to backend");
  }
};
  const openEditForm = (plan) => {
  setEditPlan(plan);

  setFormData({
    service: plan.service || "",
    plan_name: plan.plan_name || "",
    category: plan.category || "",
    recharge_date: plan.recharge_date || "",
    expiry_date: plan.expiry_date || "",
    frequency: plan.frequency || "",
    amount: plan.amount || "",
    notes: plan.notes || "",
  });

  setShowForm(true);
};
const handleDelete = async (plan) => {
  const confirmed = window.confirm(
    `Are you sure you want to delete ${plan.plan_name}?`
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:5000/plans/${plan.id}`,
      {
        method: "DELETE",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Failed to delete plan");
      return;
    }

    alert("Plan deleted successfully!");

    fetchPlans();

  } catch (error) {
    console.error("Delete error:", error);
    alert("Cannot connect to backend");
  }
};
  const openRechargeForm = (plan) => {
  setRechargePlan(plan);

  setRechargeData({
    recharge_date: new Date().toISOString().split("T")[0],
    expiry_date: "",
    amount: plan.amount || "",
    notes: "",
  });
};
  const handleRechargeChange = (event) => {
  const { name, value } = event.target;

  setRechargeData({
    ...rechargeData,
    [name]: value,
  });
};
const handleRechargeSubmit = async (event) => {
  event.preventDefault();

  if (!rechargePlan) {
    return;
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:5000/plans/${rechargePlan.id}/recharge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recharge_date: rechargeData.recharge_date,
          expiry_date: rechargeData.expiry_date || null,
          amount: Number(rechargeData.amount),
          notes: rechargeData.notes,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Recharge failed");
      return;
    }

    alert("Recharge updated successfully!");

    setRechargePlan(null);

    fetchPlans();

  } catch (error) {
    console.error("Recharge error:", error);
    alert("Cannot connect to backend");
  }
};
const openHistory = async (plan) => {
  try {
    const response = await fetch(
      `http://127.0.0.1:5000/plans/${plan.id}/history`
    );

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Failed to load recharge history");
      return;
    }

    setHistoryPlan(plan);
    setRechargeHistory(data);

  } catch (error) {
    console.error("History error:", error);
    alert("Cannot connect to backend");
  }
};

  return (
    <div className="app">

      {/* HEADER */}

      <header className="header">
        <div>
          <h1>Network Recharge Manager</h1>
          <p>Recharge & License Expiry Management System</p>
        </div>

        <button
          className="add-button"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? "Close" : "+ Add Plan"}
        </button>
      </header>


      <main className="container">
        {historyPlan && (
  <section className="form-section">

    <div className="section-header">
      <h2>
        Recharge History: {historyPlan.plan_name}
      </h2>
    </div>

    {rechargeHistory.length === 0 ? (
      <p className="message">
        No recharge history found.
      </p>
    ) : (
      <div className="history-table-container">

        <table className="history-table">

          <thead>
            <tr>
              <th>Date</th>
              <th>Old Expiry</th>
              <th>New Expiry</th>
              <th>Amount</th>
              <th>Notes</th>
            </tr>
          </thead>

          <tbody>

            {rechargeHistory.map((history) => (
              <tr key={history.id}>

                <td>
                  {history.recharge_date}
                </td>

                <td>
                  {history.old_expiry_date || "—"}
                </td>

                <td>
                  {history.new_expiry_date || "—"}
                </td>

                <td>
                  ₹{history.amount}
                </td>

                <td>
                  {history.notes || "—"}
                </td>

              </tr>
            ))}

          </tbody>

        </table>

        <button
          className="cancel-button"
          onClick={() => {
            setHistoryPlan(null);
            setRechargeHistory([]);
          }}
        >
          Close History
        </button>

      </div>
    )}

  </section>
)}
        {rechargePlan && (
  <section className="form-section">

    <h2>
      Recharge: {rechargePlan.plan_name}
    </h2>

    <form onSubmit={handleRechargeSubmit}>

      <div className="form-grid">

        <div className="form-group">
          <label>Recharge Date</label>

          <input
            type="date"
            name="recharge_date"
            value={rechargeData.recharge_date}
            onChange={handleRechargeChange}
            required
          />
        </div>


        <div className="form-group">
          <label>New Expiry Date</label>

          <input
            type="date"
            name="expiry_date"
            value={rechargeData.expiry_date}
            onChange={handleRechargeChange}
          />

          <small>
            Leave empty if you have not received the new
            expiry date yet.
          </small>
        </div>


        <div className="form-group">
          <label>Amount</label>

          <input
            type="number"
            name="amount"
            value={rechargeData.amount}
            onChange={handleRechargeChange}
          />
        </div>


        <div className="form-group">
          <label>Notes</label>

          <input
            type="text"
            name="notes"
            value={rechargeData.notes}
            onChange={handleRechargeChange}
            placeholder="Example: Monthly recharge completed"
          />
        </div>

      </div>


      <div className="recharge-actions">

        <button
          type="button"
          className="cancel-button"
          onClick={() => setRechargePlan(null)}
        >
          Cancel
        </button>

        <button
          type="submit"
          className="save-button"
        >
          Save Recharge
        </button>

      </div>

    </form>

  </section>
)}

        {/* ADD PLAN FORM */}

        {showForm && (
          <section className="form-section">

            <h2>{editPlan ? "Edit Plan" : "Add New Plan"}</h2>

            <form onSubmit={handleSubmit}>

              <div className="form-grid">

                <div className="form-group">
                  <label>Service</label>

                  <select
                    name="service"
                    value={formData.service}
                    onChange={handleChange}
                    required
                  >
                    <option value="">Select Service</option>
                    <option value="RailTel">RailTel</option>
                    <option value="Jio">Jio</option>
                    <option value="BSNL">BSNL</option>
                    <option value="Software License">
                      Software License
                    </option>
                    <option value="Hotspot">Hotspot</option>
                  </select>
                </div>


                <div className="form-group">
                  <label>Plan Name</label>

                  <input
                    type="text"
                    name="plan_name"
                    value={formData.plan_name}
                    onChange={handleChange}
                    placeholder="Example: RailTel Plan 2"
                    required
                  />
                </div>


                <div className="form-group">
                  <label>Category</label>

                  <select
                    name="category"
                    value={formData.category}
                    onChange={handleChange}
                    required
                  >
                    <option value="">Select Category</option>
                    <option value="Network">Network</option>
                    <option value="SIM">SIM</option>
                    <option value="Software">Software</option>
                    <option value="Hotspot">Hotspot</option>
                  </select>
                </div>


                <div className="form-group">
                  <label>Frequency</label>

                  <select
                    name="frequency"
                    value={formData.frequency}
                    onChange={handleChange}
                  >
                    <option value="">Select Frequency</option>
                    <option value="Monthly">Monthly</option>
                    <option value="Quarterly">Quarterly</option>
                    <option value="Half-Yearly">
                      Half-Yearly
                    </option>
                    <option value="Yearly">Yearly</option>
                  </select>
                </div>


                <div className="form-group">
                  <label>Recharge Date</label>

                  <input
                    type="date"
                    name="recharge_date"
                    value={formData.recharge_date}
                    onChange={handleChange}
                  />
                </div>


                <div className="form-group">
                  <label>Expiry Date</label>

                  <input
                    type="date"
                    name="expiry_date"
                    value={formData.expiry_date}
                    onChange={handleChange}
                  />
                </div>


                <div className="form-group">
                  <label>Amount</label>

                  <input
                    type="number"
                    name="amount"
                    value={formData.amount}
                    onChange={handleChange}
                    placeholder="5000"
                  />
                </div>


                <div className="form-group">
                  <label>Notes</label>

                  <input
                    type="text"
                    name="notes"
                    value={formData.notes}
                    onChange={handleChange}
                    placeholder="Additional information"
                  />
                </div>

              </div>


              <button className="save-button" type="submit">
  {editPlan ? "Update Plan" : "Save Plan"}
</button>

            </form>

          </section>
        )}


        {/* SUMMARY */}

        <section className="summary">
          {planStats.map((stat) => (
            <div className={`summary-card ${stat.className}`} key={stat.label}>
              <h3>{stat.label}</h3>
              <p>
                {stat.status === null
                  ? plans.length
                  : plans.filter((plan) => plan.status === stat.status).length}
              </p>
            </div>
          ))}
</section>

        <section className="service-summary-section" aria-labelledby="service-summary-title">
          <div className="section-header">
            <h2 id="service-summary-title">Service Summary</h2>
          </div>

          {serviceStats.length === 0 ? (
            <p className="message">No service plans to summarize yet.</p>
          ) : (
            <div className="service-summary-grid">
              {serviceStats.map(([service, count]) => (
                <button
                  type="button"
                  className={`service-summary-card${serviceFilter === service ? " is-selected" : ""}`}
                  key={service}
                  aria-pressed={serviceFilter === service}
                  onClick={() => setServiceFilter(serviceFilter === service ? "" : service)}
                >
                  <h3>{service}</h3>
                  <p>{count} {count === 1 ? "Plan" : "Plans"}</p>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="renewals-section" aria-labelledby="renewals-title">
          <div className="section-header">
            <h2 id="renewals-title">Upcoming Renewals</h2>
          </div>

          {upcomingRenewals.length === 0 ? (
            <p className="message">No upcoming renewals.</p>
          ) : (
            <div className="renewals-grid">
              {upcomingRenewals.map((plan) => (
                <button
                  type="button"
                  className="renewal-card"
                  key={plan.id}
                  aria-label={`Show ${plan.service} ${plan.plan_name} in the plans list`}
                  aria-pressed={selectedRenewal?.planId === plan.id}
                  onClick={() => revealRenewalPlan(plan)}
                >
                  <div className="renewal-card-header">
                    <div>
                      <h3>{plan.service}</h3>
                      <p>{plan.plan_name}</p>
                    </div>
                    <span className={`status status-${plan.status.toLowerCase().replaceAll(" ", "-")}`}>
                      {plan.status}
                    </span>
                  </div>
                  <div className="renewal-details">
                    <div>
                      <span>Expiry Date</span>
                      <strong>{plan.expiry_date || "Not set"}</strong>
                    </div>
                    <div>
                      <span>Days Remaining</span>
                      <strong>{formatDaysRemaining(plan)}</strong>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>


        {/* PLANS */}

        <section className="filters-section" aria-label="Search and filter plans">
          <div className="search-field">
            <label htmlFor="plan-search">🔍 Search plans...</label>
            <input
              id="plan-search"
              type="search"
              placeholder="Search plans..."
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </div>

          <div className="filter-field">
            <label htmlFor="service-filter">Service</label>
            <select
              id="service-filter"
              value={serviceFilter}
              onChange={(event) => setServiceFilter(event.target.value)}
            >
              <option value="">All Services</option>
              <option value="RailTel">RailTel</option>
              <option value="Jio">Jio</option>
              <option value="BSNL">BSNL</option>
              <option value="Software License">Software License</option>
              <option value="Hotspot">Hotspot</option>
            </select>
          </div>

          <div className="filter-field">
            <label htmlFor="status-filter">Status</label>
            <select
              id="status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">All Status</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="UPCOMING">UPCOMING</option>
              <option value="DUE SOON">DUE SOON</option>
              <option value="DUE TODAY">DUE TODAY</option>
              <option value="EXPIRED">EXPIRED</option>
              <option value="UPDATE REQUIRED">UPDATE REQUIRED</option>
            </select>
          </div>

          <div className="plan-filter-actions">
            <button type="button" className="clear-filters-button" onClick={clearFilters}>
              Clear Filters
            </button>
            <button
              type="button"
              className="export-plans-button"
              onClick={exportPlansCsv}
              disabled={loading || filteredPlans.length === 0}
            >
              Export Plans CSV
            </button>
            {!loading && filteredPlans.length === 0 && (
              <small className="export-plans-empty">No plans to export.</small>
            )}
          </div>
        </section>

        <section className="plans-section" id="all-plans-section">

          <div className="section-header">
            <h2>All Plans</h2>
            <p className="result-count">Showing {filteredPlans.length} of {plans.length} plans</p>
          </div>

          {loading ? (
            <p className="message">
              Loading plans...
            </p>
          ) : plans.length === 0 ? (
            <p className="message">
              No plans found.
            </p>
          ) : filteredPlans.length === 0 ? (
            <p className="message">No plans match your search and filters.</p>
          ) : (

            <div className="plans-grid">

              {filteredPlans.map((plan) => (

                <div
                  id={`plan-card-${plan.id}`}
                  data-plan-id={plan.id}
                  className={`plan-card${selectedRenewal?.planId === plan.id ? " is-highlighted" : ""}`}
                  key={plan.id}
                >

                  <div className="plan-header">

                    <div>
                      <h3>{plan.service}</h3>

                      <p>
                        {plan.plan_name}
                      </p>
                    </div>

                   <span
  className={`status status-${plan.status
    .toLowerCase()
    .replaceAll(" ", "-")}`}
>
  {plan.status}
</span>

                  </div>


                  <div className="plan-details">

                    <div>
                      <span>Category</span>
                      <strong>
                        {plan.category}
                      </strong>
                    </div>


                    <div>
  <span>Expiry Date</span>

  <strong>
    {plan.expiry_date}
  </strong>

  {plan.days_remaining !== null && (
    <small>
      {plan.days_remaining > 0
        ? `${plan.days_remaining} days remaining`
        : plan.days_remaining === 0
        ? "Expires today"
        : `${Math.abs(plan.days_remaining)} days expired`}
    </small>
  )}
</div>


                    <div>
                      <span>Frequency</span>
                      <strong>
                        {plan.frequency}
                      </strong>
                    </div>


                    <div>
                      <span>Amount</span>
                      <strong>
                        ₹{plan.amount}
                      </strong>
                    </div>

                  </div>


                  {plan.notes && (
                    <div className="notes">
                      <strong>Notes:</strong>{" "}
                      {plan.notes}
                    </div>
                  )}
              <div className="plan-actions">

  <button
    className="recharge-button"
    onClick={() => openRechargeForm(plan)}
  >
    🔄 Recharge
  </button>

  <button
    className="history-button"
    onClick={() => openHistory(plan)}
  >
    📋 History
  </button>

  <button
    className="edit-button"
    onClick={() => openEditForm(plan)}
  >
    ✏️ Edit
  </button>

  <button
  className="delete-button"
  onClick={() => handleDelete(plan)}
>
  🗑 Delete
</button>

</div>

                  

                </div>

              ))}

            </div>

          )}

        </section>

        <section className="reminder-history-section" aria-labelledby="reminder-history-title">
          <div className="section-header reminder-history-header">
            <h2 id="reminder-history-title">Reminder History</h2>
            <div className="reminder-history-actions">
              <button
                type="button"
                className="refresh-reminders-button"
                onClick={fetchReminders}
                disabled={remindersLoading}
              >
                {remindersLoading ? "Refreshing..." : "Refresh"}
              </button>
              <button
                type="button"
                className="refresh-reminders-button export-reminders-button"
                onClick={exportReminderHistory}
                disabled={remindersLoading || filteredReminders.length === 0}
              >
                Export CSV
              </button>
            </div>
          </div>

          <div className="reminder-filters" aria-label="Filter reminder history">
            <div className="reminder-filter-field">
              <label htmlFor="reminder-service-filter">Service</label>
              <select
                id="reminder-service-filter"
                value={reminderServiceFilter}
                onChange={(event) => setReminderServiceFilter(event.target.value)}
              >
                <option value="">All Services</option>
                {reminderServices.map((service) => (
                  <option value={service} key={service}>{service}</option>
                ))}
              </select>
            </div>

            <div className="reminder-filter-field">
              <label htmlFor="reminder-type-filter">Reminder Type</label>
              <select
                id="reminder-type-filter"
                value={reminderTypeFilter}
                onChange={(event) => setReminderTypeFilter(event.target.value)}
              >
                <option value="">All Types</option>
                <option value="7_DAYS">7 Days</option>
                <option value="3_DAYS">3 Days</option>
                <option value="DUE_TODAY">Due Today</option>
                <option value="EXPIRED">Expired</option>
                <option value="EXPIRY_MISSING">Expiry Missing</option>
              </select>
            </div>

            <div className="reminder-filter-field reminder-search-field">
              <label htmlFor="reminder-plan-search">Search</label>
              <input
                id="reminder-plan-search"
                type="search"
                placeholder="Plan name..."
                value={reminderSearchText}
                onChange={(event) => setReminderSearchText(event.target.value)}
              />
            </div>

            <button
              type="button"
              className="clear-filters-button reminder-clear-button"
              onClick={clearReminderFilters}
            >
              Clear Filters
            </button>
          </div>

          {!remindersLoading && !remindersError && filteredReminders.length === 0 && (
            <p className="export-empty-message">No reminder records to export.</p>
          )}

          {remindersLoading ? (
            <p className="message">Loading reminder history...</p>
          ) : remindersError ? (
            <p className="message">{remindersError}</p>
          ) : reminders.length === 0 ? (
            <p className="message">No reminder history found.</p>
          ) : filteredReminders.length === 0 ? (
            <p className="message">No reminders match the selected filters.</p>
          ) : (
            <div className="history-table-container reminder-history-table-container">
              <table className="history-table reminder-history-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Plan Name</th>
                    <th>Reminder Type</th>
                    <th>Expiry Date</th>
                    <th>Created At</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReminders.map((reminder) => (
                    <tr key={reminder.id}>
                      <td>{reminder.service || "—"}</td>
                      <td>{reminder.plan_name || "—"}</td>
                      <td>
                        <span className={`reminder-type reminder-type-${String(reminder.reminder_type || "").toLowerCase().replaceAll("_", "-")}`}>
                          {String(reminder.reminder_type || "").replaceAll("_", " ")}
                        </span>
                      </td>
                      <td>{reminder.expiry_date || "—"}</td>
                      <td>
                        {reminder.created_at
                          ? new Date(reminder.created_at).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </main>

    </div>
  );
}

export default App;
