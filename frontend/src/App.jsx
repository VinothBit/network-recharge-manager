import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const PLAN_CSV_COLUMNS = [
  "Service",
  "Plan Name",
  "Category",
  "Recharge Date",
  "Expiry Date",
  "Frequency",
  "Amount",
  "Notes",
];

const parseCsvText = (text) => {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new Error("The CSV contains an unclosed quoted field.");
  }

  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
};

const parseCalendarDate = (value) => {
  if (typeof value !== "string") return null;

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return {
    date,
    key: `${yearText}-${monthText}-${dayText}`,
  };
};

const getLocalDateKey = (date) => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
);

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
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [showImportPreview, setShowImportPreview] = useState(false);
  const [importPreview, setImportPreview] = useState([]);
  const [importError, setImportError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupError, setBackupError] = useState("");
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
  const importFileInputRef = useRef(null);
  const restoreFileInputRef = useRef(null);

  const [rechargePlan, setRechargePlan] = useState(null);

  const [historyPlan, setHistoryPlan] = useState(null);
const [rechargeHistory, setRechargeHistory] = useState([]);
const [rechargeHistoryLoading, setRechargeHistoryLoading] = useState(false);

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
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) || null;
  const selectedPlanReminders = reminders.filter(
    (reminder) => String(reminder.plan_id) === String(selectedPlanId)
  );

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

  const serviceExpenseStats = Object.entries(
    plans.reduce((totals, plan) => {
      const service = String(plan.service || "").trim();
      if (!service) return totals;

      if (!totals[service]) {
        totals[service] = { planCount: 0, totalAmount: 0 };
      }

      totals[service].planCount += 1;

      const rawAmount = plan.amount;
      const numericAmount = typeof rawAmount === "number"
        ? rawAmount
        : typeof rawAmount === "string" && rawAmount.trim() !== ""
        ? Number(rawAmount)
        : 0;

      if (Number.isFinite(numericAmount)) {
        totals[service].totalAmount += numericAmount;
      }

      return totals;
    }, {})
  );

  const formatCurrency = (amount) => new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);

  const monthlyExpenseStats = Object.entries(
    plans.reduce((months, plan) => {
      const dateMatch = String(plan.recharge_date || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!dateMatch) return months;

      const [, yearText, monthText, dayText] = dateMatch;
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      const validDate = new Date(year, month - 1, day);

      if (
        validDate.getFullYear() !== year ||
        validDate.getMonth() !== month - 1 ||
        validDate.getDate() !== day
      ) {
        return months;
      }

      const monthKey = `${yearText}-${monthText}`;
      if (!months[monthKey]) {
        months[monthKey] = {
          monthDate: new Date(year, month - 1, 1),
          planCount: 0,
          totalAmount: 0,
        };
      }

      months[monthKey].planCount += 1;

      const rawAmount = plan.amount;
      const numericAmount = typeof rawAmount === "number"
        ? rawAmount
        : typeof rawAmount === "string" && rawAmount.trim() !== ""
        ? Number(rawAmount)
        : 0;

      if (Number.isFinite(numericAmount)) {
        months[monthKey].totalAmount += numericAmount;
      }

      return months;
    }, {})
  ).sort(([monthA], [monthB]) => monthB.localeCompare(monthA));

  const calendarEventsByDate = plans.reduce((eventsByDate, plan) => {
    [
      ["recharge_date", "Recharge"],
      ["expiry_date", "Expiry"],
    ].forEach(([dateField, eventType]) => {
      const parsedDate = parseCalendarDate(plan[dateField]);
      if (!parsedDate) return;

      if (!eventsByDate.has(parsedDate.key)) {
        eventsByDate.set(parsedDate.key, []);
      }

      eventsByDate.get(parsedDate.key).push({
        plan,
        eventType,
        id: `${plan.id}-${dateField}`,
      });
    });

    return eventsByDate;
  }, new Map());

  const calendarYear = calendarMonth.getFullYear();
  const calendarMonthIndex = calendarMonth.getMonth();
  const calendarDaysInMonth = new Date(calendarYear, calendarMonthIndex + 1, 0).getDate();
  const calendarStartOffset = new Date(calendarYear, calendarMonthIndex, 1).getDay();
  const todayKey = getLocalDateKey(new Date());
  const calendarCells = Array.from({ length: 42 }, (_, index) => {
    const day = index - calendarStartOffset + 1;
    if (day < 1 || day > calendarDaysInMonth) {
      return { key: `blank-${index}`, day: null, events: [] };
    }

    const dateKey = getLocalDateKey(new Date(calendarYear, calendarMonthIndex, day));
    return {
      key: dateKey,
      day,
      dateKey,
      isToday: dateKey === todayKey,
      events: calendarEventsByDate.get(dateKey) || [],
    };
  });

  const calendarTitle = new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
  }).format(calendarMonth);

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

  const handlePlanCsvSelection = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setImportError("");
    setImportMessage("");
    setImportPreview([]);

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setImportError("Please select a .csv file.");
      setShowImportPreview(true);
      return;
    }

    try {
      const rows = parseCsvText(await file.text());
      if (rows.length === 0) {
        throw new Error("The CSV file is empty.");
      }

      const headers = rows[0].map((header, index) => {
        const normalized = header.trim().replace(/^\uFEFF/, "").toLowerCase();
        return [normalized, index];
      });
      const headerIndexes = new Map(headers);
      const missingHeaders = PLAN_CSV_COLUMNS.filter(
        (column) => !headerIndexes.has(column.toLowerCase())
      );

      if (missingHeaders.length > 0) {
        throw new Error(`Missing required columns: ${missingHeaders.join(", " )}`);
      }

      const previewRows = rows.slice(1).map((csvRow, index) => {
        const readColumn = (name) => {
          const value = csvRow[headerIndexes.get(name.toLowerCase())] ?? "";
          return value.trim();
        };
        const plan = {
          service: readColumn("Service"),
          plan_name: readColumn("Plan Name"),
          category: readColumn("Category"),
          recharge_date: readColumn("Recharge Date"),
          expiry_date: readColumn("Expiry Date"),
          frequency: readColumn("Frequency"),
          amount: readColumn("Amount"),
          notes: readColumn("Notes"),
        };
        const errors = [];

        if (!plan.service) errors.push("Service is required.");
        if (!plan.plan_name) errors.push("Plan Name is required.");
        if (!plan.category) errors.push("Category is required.");

        ["recharge_date", "expiry_date"].forEach((dateField) => {
          if (plan[dateField] && !parseCalendarDate(plan[dateField])) {
            errors.push(`${dateField === "recharge_date" ? "Recharge Date" : "Expiry Date"} must use YYYY-MM-DD.`);
          }
        });

        if (plan.amount && !Number.isFinite(Number(plan.amount))) {
          errors.push("Amount must be numeric.");
        }

        return {
          rowNumber: index + 2,
          plan,
          errors,
          valid: errors.length === 0,
          apiError: "",
        };
      });

      setImportPreview(previewRows);
      setShowImportPreview(true);
      if (previewRows.length === 0) {
        setImportMessage("The CSV contains headers but no plan rows.");
      }
    } catch (error) {
      setImportError(error.message || "Unable to read this CSV file.");
      setShowImportPreview(true);
    }
  };

  const importValidPlans = async () => {
    const validRows = importPreview.filter((row) => row.valid);
    if (validRows.length === 0 || isImporting) return;

    setIsImporting(true);
    setImportMessage("");
    const failedRows = [];
    let importedCount = 0;

    for (const row of validRows) {
      try {
        const response = await fetch("http://127.0.0.1:5000/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...row.plan,
            amount: row.plan.amount === "" ? null : Number(row.plan.amount),
          }),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || `Request failed (${response.status}).`);
        }

        importedCount += 1;
      } catch (error) {
        failedRows.push({
          ...row,
          apiError: error.message || "Import request failed.",
        });
      }
    }

    await fetchPlans();

    const validationFailures = importPreview.filter((row) => !row.valid);
    const remainingRows = [...validationFailures, ...failedRows]
      .sort((a, b) => a.rowNumber - b.rowNumber);
    setImportPreview(remainingRows);
    setImportMessage(
      `${importedCount} plan${importedCount === 1 ? "" : "s"} imported.` +
      (failedRows.length > 0 ? ` ${failedRows.length} row request${failedRows.length === 1 ? "" : "s"} failed; review or retry them below.` : "")
    );

    if (remainingRows.length === 0) {
      setShowImportPreview(false);
    }

    setIsImporting(false);
  };

  const cancelPlanImport = () => {
    setShowImportPreview(false);
    setImportPreview([]);
    setImportError("");
    setImportMessage("");
    if (importFileInputRef.current) importFileInputRef.current.value = "";
  };

  const downloadDatabaseBackup = async () => {
    setBackupMessage("");
    setBackupError("");
    setIsBackingUp(true);

    try {
      const response = await fetch("http://127.0.0.1:5000/backup/database");
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Unable to download database backup.");
      }

      const backupBlob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(backupBlob);
      const downloadLink = document.createElement("a");
      downloadLink.href = downloadUrl;
      downloadLink.download = "recharge_manager_backup.db";
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 0);
      setBackupMessage("Database backup downloaded successfully.");
    } catch (error) {
      console.error("Database backup error:", error);
      setBackupError(error.message || "Unable to download database backup.");
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestoreFileSelection = (event) => {
    const selectedFile = event.target.files?.[0] || null;
    setRestoreMessage("");
    setRestoreError("");

    if (selectedFile && !selectedFile.name.toLowerCase().endsWith(".db")) {
      setRestoreFile(null);
      setRestoreError("Please select a .db backup file.");
      event.target.value = "";
      return;
    }

    setRestoreFile(selectedFile);
  };

  const cancelDatabaseRestore = () => {
    setRestoreFile(null);
    setRestoreError("");
    if (restoreFileInputRef.current) restoreFileInputRef.current.value = "";
  };

  const confirmDatabaseRestore = async () => {
    if (!restoreFile || isRestoring) return;

    setRestoreMessage("");
    setRestoreError("");
    setIsRestoring(true);

    try {
      const formData = new FormData();
      formData.append("database", restoreFile);
      const response = await fetch("http://127.0.0.1:5000/restore/database", {
        method: "POST",
        body: formData,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.error || "Database restore failed.");
      }

      await Promise.all([fetchPlans(), fetchReminders()]);
      setRestoreFile(null);
      setRestoreMessage(
        "Database restored successfully. A safety backup of the previous database was created."
      );
      if (restoreFileInputRef.current) restoreFileInputRef.current.value = "";
    } catch (error) {
      console.error("Database restore error:", error);
      setRestoreError(error.message || "Database restore failed.");
    } finally {
      setIsRestoring(false);
    }
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

  useEffect(() => {
    if (selectedPlanId === null) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      document.getElementById("plan-details-view")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [selectedPlanId]);

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

    if (String(selectedPlanId) === String(plan.id)) {
      closePlanDetails();
    }

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
const loadRechargeHistory = async (plan) => {
  setRechargeHistoryLoading(true);
  try {
    const response = await fetch(
      `http://127.0.0.1:5000/plans/${plan.id}/history`
    );

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "Failed to load recharge history");
      return null;
    }

    return data;

  } catch (error) {
    console.error("History error:", error);
    alert("Cannot connect to backend");
    return null;
  } finally {
    setRechargeHistoryLoading(false);
  }
};

const openHistory = async (plan) => {
  const data = await loadRechargeHistory(plan);
  if (data === null) return;

  setSelectedPlanId(null);
  setHistoryPlan(plan);
  setRechargeHistory(data);
};

const openPlanDetails = async (plan) => {
  setHistoryPlan(null);
  setRechargeHistory([]);
  setSelectedPlanId(plan.id);

  const data = await loadRechargeHistory(plan);
  if (data !== null) {
    setRechargeHistory(data);
  }
};

const closePlanDetails = () => {
  setSelectedPlanId(null);
  setHistoryPlan(null);
  setRechargeHistory([]);
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
        {historyPlan && !selectedPlan && (
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

        {selectedPlan && (
          <section className="plan-details-view" id="plan-details-view" aria-labelledby="plan-details-title">
            <div className="plan-details-view-header">
              <div>
                <p className="plan-details-eyebrow">Plan Details</p>
                <h2 id="plan-details-title">{selectedPlan.plan_name}</h2>
              </div>
              <button type="button" className="cancel-button" onClick={closePlanDetails}>
                Close / Back to Plans
              </button>
            </div>

            <div className="plan-information-grid">
              <div><span>Service</span><strong>{selectedPlan.service || "—"}</strong></div>
              <div><span>Plan Name</span><strong>{selectedPlan.plan_name || "—"}</strong></div>
              <div><span>Category</span><strong>{selectedPlan.category || "—"}</strong></div>
              <div><span>Recharge Date</span><strong>{selectedPlan.recharge_date || "—"}</strong></div>
              <div><span>Expiry Date</span><strong>{selectedPlan.expiry_date || "—"}</strong></div>
              <div><span>Frequency</span><strong>{selectedPlan.frequency || "—"}</strong></div>
              <div><span>Amount</span><strong>{selectedPlan.amount ?? "—"}</strong></div>
              <div>
                <span>Status</span>
                <strong>
                  <span className={`status status-${String(selectedPlan.status || "").toLowerCase().replaceAll(" ", "-")}`}>
                    {selectedPlan.status || "—"}
                  </span>
                </strong>
              </div>
              <div><span>Days Remaining</span><strong>{formatDaysRemaining(selectedPlan)}</strong></div>
              <div className="plan-information-notes"><span>Notes</span><strong>{selectedPlan.notes || "—"}</strong></div>
            </div>

            <div className="plan-details-actions">
              <button type="button" className="recharge-button" onClick={() => openRechargeForm(selectedPlan)}>
                Recharge
              </button>
              <button type="button" className="edit-button" onClick={() => openEditForm(selectedPlan)}>
                Edit
              </button>
              <button type="button" className="delete-button" onClick={() => handleDelete(selectedPlan)}>
                Delete
              </button>
            </div>

            <div className="plan-history-section">
              <h3>Recharge History</h3>
              {rechargeHistoryLoading ? (
                <p className="message">Loading recharge history...</p>
              ) : rechargeHistory.length === 0 ? (
                <p className="message">No recharge history found.</p>
              ) : (
                <div className="history-table-container">
                  <table className="history-table">
                    <thead>
                      <tr><th>Recharge Date</th><th>Old Expiry</th><th>New Expiry</th><th>Amount</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                      {rechargeHistory.map((history) => (
                        <tr key={history.id}>
                          <td>{history.recharge_date}</td>
                          <td>{history.old_expiry_date || "—"}</td>
                          <td>{history.new_expiry_date || "—"}</td>
                          <td>{history.amount ?? "—"}</td>
                          <td>{history.notes || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="plan-history-section">
              <h3>Reminder History</h3>
              {selectedPlanReminders.length === 0 ? (
                <p className="message">No reminder history found for this plan.</p>
              ) : (
                <div className="history-table-container">
                  <table className="history-table">
                    <thead>
                      <tr><th>Reminder Type</th><th>Expiry Date</th><th>Created At</th></tr>
                    </thead>
                    <tbody>
                      {selectedPlanReminders.map((reminder) => (
                        <tr key={reminder.id}>
                          <td>{String(reminder.reminder_type || "").replaceAll("_", " ")}</td>
                          <td>{reminder.expiry_date || "—"}</td>
                          <td>{reminder.created_at ? new Date(reminder.created_at).toLocaleString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
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

        <section className="expense-summary-section" aria-labelledby="expense-summary-title">
          <div className="section-header">
            <h2 id="expense-summary-title">Service-wise Expense Summary</h2>
          </div>

          {serviceExpenseStats.length === 0 ? (
            <p className="message">No service expenses to summarize yet.</p>
          ) : (
            <div className="expense-summary-grid">
              {serviceExpenseStats.map(([service, totals]) => (
                <div className="expense-summary-card" key={service}>
                  <h3>{service}</h3>
                  <p>{totals.planCount} {totals.planCount === 1 ? "Plan" : "Plans"}</p>
                  <strong>{formatCurrency(totals.totalAmount)}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="expense-summary-section monthly-expense-section" aria-labelledby="monthly-expense-title">
          <div className="section-header">
            <h2 id="monthly-expense-title">Monthly Expense Summary</h2>
          </div>

          {monthlyExpenseStats.length === 0 ? (
            <p className="message">No plans with valid recharge dates to summarize yet.</p>
          ) : (
            <div className="expense-summary-grid">
              {monthlyExpenseStats.map(([monthKey, totals]) => (
                <div className="expense-summary-card monthly-expense-card" key={monthKey}>
                  <h3>
                    {new Intl.DateTimeFormat("en-IN", {
                      month: "long",
                      year: "numeric",
                    }).format(totals.monthDate)}
                  </h3>
                  <p>{totals.planCount} {totals.planCount === 1 ? "Plan" : "Plans"}</p>
                  <strong>{formatCurrency(totals.totalAmount)}</strong>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="calendar-section" aria-labelledby="calendar-title">
          <div className="calendar-section-header">
            <h2 id="calendar-title">Recharge &amp; Expiry Calendar</h2>
            <div className="calendar-navigation">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() - 1, 1))}
              >
                ‹
              </button>
              <h3>{calendarTitle}</h3>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() + 1, 1))}
              >
                ›
              </button>
            </div>
          </div>

          <div className="calendar-legend" aria-label="Calendar event legend">
            <span><i className="calendar-legend-dot recharge-event-dot" />Recharge</span>
            <span><i className="calendar-legend-dot expiry-event-dot" />Expiry</span>
          </div>

          <div className="calendar-scroll-container">
            <div className="calendar-grid">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday) => (
                <div className="calendar-weekday" key={weekday}>{weekday}</div>
              ))}

              {calendarCells.map((cell) => (
                <div
                  key={cell.key}
                  className={`calendar-day${cell.day === null ? " is-empty" : ""}${cell.isToday ? " is-today" : ""}`}
                >
                  {cell.day !== null && (
                    <>
                      <span className="calendar-day-number">{cell.day}</span>
                      <div className="calendar-day-events">
                        {cell.events.map((event) => (
                          <button
                            type="button"
                            key={event.id}
                            className={`calendar-event ${event.eventType === "Recharge" ? "recharge-event" : "expiry-event"}`}
                            aria-label={`${event.eventType} event for ${event.plan.plan_name} (${event.plan.service})`}
                            onClick={() => openPlanDetails(event.plan)}
                          >
                            <strong>{event.plan.plan_name}</strong>
                            <span>{event.plan.service}</span>
                            <small>{event.eventType}</small>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
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
                <div className="renewal-item" key={plan.id}>
                  <button
                    type="button"
                    className="renewal-card"
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
                  <button
                    type="button"
                    className="renewal-open-details"
                    onClick={() => openPlanDetails(plan)}
                  >
                    View Plan Details
                  </button>
                </div>
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
            <button
              type="button"
              className="import-plans-button"
              onClick={() => importFileInputRef.current?.click()}
              disabled={isImporting}
            >
              Import Plans CSV
            </button>
            <button
              type="button"
              className="backup-database-button"
              onClick={downloadDatabaseBackup}
              disabled={isBackingUp}
            >
              {isBackingUp ? "Preparing Backup..." : "Backup Database"}
            </button>
            <button
              type="button"
              className="restore-database-button"
              onClick={() => restoreFileInputRef.current?.click()}
              disabled={isRestoring}
            >
              Restore Database
            </button>
            <input
              ref={restoreFileInputRef}
              className="import-plans-file-input"
              type="file"
              accept=".db"
              onChange={handleRestoreFileSelection}
            />
            <input
              ref={importFileInputRef}
              className="import-plans-file-input"
              type="file"
              accept=".csv,text/csv"
              onChange={handlePlanCsvSelection}
            />
            {!loading && filteredPlans.length === 0 && (
              <small className="export-plans-empty">No plans to export.</small>
            )}
            {backupMessage && (
              <small className="backup-database-message" role="status">
                {backupMessage}
              </small>
            )}
            {backupError && (
              <small className="backup-database-error" role="alert">
                {backupError}
              </small>
            )}
          </div>
        </section>

        {restoreFile && (
          <section className="restore-confirmation" aria-labelledby="restore-confirmation-title">
            <h3 id="restore-confirmation-title">Confirm Database Restore</h3>
            <p className="restore-selected-file">Selected file: <strong>{restoreFile.name}</strong></p>
            <p className="restore-warning">
              Restoring a database will replace the current application data.
              A safety backup of the current database will be created first.
            </p>
            {restoreError && <p className="restore-error" role="alert">{restoreError}</p>}
            <div className="restore-confirmation-actions">
              <button
                type="button"
                className="restore-confirm-button"
                onClick={confirmDatabaseRestore}
                disabled={isRestoring}
              >
                {isRestoring ? "Restoring..." : "Confirm Restore"}
              </button>
              <button
                type="button"
                className="restore-cancel-button"
                onClick={cancelDatabaseRestore}
                disabled={isRestoring}
              >
                Cancel
              </button>
            </div>
          </section>
        )}
        {restoreMessage && <p className="restore-success" role="status">{restoreMessage}</p>}
        {!restoreFile && restoreError && <p className="restore-error" role="alert">{restoreError}</p>}
        {importMessage && <p className="plan-import-message">{importMessage}</p>}

        {showImportPreview && (
          <section className="plan-import-section" aria-labelledby="plan-import-title">
            <div className="plan-import-header">
              <h2 id="plan-import-title">Import Plans Preview</h2>
              {!importError && (
                <div className="plan-import-counts">
                  <span>Total rows: <strong>{importPreview.length}</strong></span>
                  <span>Valid rows: <strong>{importPreview.filter((row) => row.valid).length}</strong></span>
                  <span>Invalid rows: <strong>{importPreview.filter((row) => !row.valid).length}</strong></span>
                </div>
              )}
            </div>

            {importError ? (
              <p className="plan-import-error">{importError}</p>
            ) : importPreview.length === 0 ? (
              <p className="message">The CSV contains no plan rows to preview.</p>
            ) : (
              <div className="plan-import-table-container">
                <table className="plan-import-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Service</th>
                      <th>Plan Name</th>
                      <th>Category</th>
                      <th>Recharge Date</th>
                      <th>Expiry Date</th>
                      <th>Frequency</th>
                      <th>Amount</th>
                      <th>Notes</th>
                      <th>Validation Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.map((row) => (
                      <tr className={row.valid ? "import-row-valid" : "import-row-invalid"} key={row.rowNumber}>
                        <td>{row.rowNumber}</td>
                        <td>{row.plan.service || "—"}</td>
                        <td>{row.plan.plan_name || "—"}</td>
                        <td>{row.plan.category || "—"}</td>
                        <td>{row.plan.recharge_date || "—"}</td>
                        <td>{row.plan.expiry_date || "—"}</td>
                        <td>{row.plan.frequency || "—"}</td>
                        <td>{row.plan.amount || "—"}</td>
                        <td className="import-notes-cell">{row.plan.notes || "—"}</td>
                        <td>
                          <span className={`import-row-status ${row.valid && !row.apiError ? "is-valid" : "is-invalid"}`}>
                            {row.errors.length > 0
                              ? `Invalid: ${row.errors.join(" ")}`
                              : row.apiError
                              ? `Import failed: ${row.apiError}`
                              : "Valid"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="plan-import-actions">
              <button
                type="button"
                className="import-confirm-button"
                onClick={importValidPlans}
                disabled={isImporting || !importPreview.some((row) => row.valid)}
              >
                {isImporting ? "Importing..." : "Import Valid Plans"}
              </button>
              <button
                type="button"
                className="cancel-button"
                onClick={cancelPlanImport}
                disabled={isImporting}
              >
                Cancel
              </button>
            </div>
          </section>
        )}

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
                  role="button"
                  tabIndex={0}
                  aria-label={`Open details for ${plan.service} ${plan.plan_name}`}
                  onClick={() => openPlanDetails(plan)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openPlanDetails(plan);
                    }
                  }}
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
    onClick={(event) => {
      event.stopPropagation();
      openRechargeForm(plan);
    }}
  >
    🔄 Recharge
  </button>

  <button
    className="history-button"
    onClick={(event) => {
      event.stopPropagation();
      openHistory(plan);
    }}
  >
    📋 History
  </button>

  <button
    className="edit-button"
    onClick={(event) => {
      event.stopPropagation();
      openEditForm(plan);
    }}
  >
    ✏️ Edit
  </button>

  <button
  className="delete-button"
  onClick={(event) => {
    event.stopPropagation();
    handleDelete(plan);
  }}
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
