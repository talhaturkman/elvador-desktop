const crypto = require('crypto');

function makeTempId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function makeEntryId() {
  return `off_entry_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function parseUrlParts(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''), 'http://elvador.local');
  } catch (_) {
    return null;
  }
  return parsed;
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return String(value || '');
  }
}

function matchAllowlistedRoute(method, rawUrl) {
  const m = String(method || '').toUpperCase();
  const parsed = parseUrlParts(rawUrl);
  if (!parsed) return null;
  const p = parsed.pathname;
  let match;

  // Hotel PMS routes
  if (m === 'PUT' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/rooms\/([^/]+)\/status$/))) {
    return {
      kind: 'pms_room_status',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase(),
      roomId: decodePart(match[3])
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/notes$/))) {
    return {
      kind: 'pms_note_create',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'DELETE' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/notes\/([^/]+)$/))) {
    return {
      kind: 'pms_note_delete',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase(),
      noteId: decodePart(match[3])
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/assignments$/))) {
    return {
      kind: 'pms_assign',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/check-in$/))) {
    return {
      kind: 'pms_check_in',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/check-out$/))) {
    return {
      kind: 'pms_check_out',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/move-room$/))) {
    return {
      kind: 'pms_move_room',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'PUT' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/reservations\/([^/]+)\/guests$/))) {
    return {
      kind: 'pms_update_guests',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase(),
      reservationId: decodePart(match[3])
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/no-show$/))) {
    return {
      kind: 'pms_no_show',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/extend-stay$/))) {
    return {
      kind: 'pms_extend_stay',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/front-office\/manual-reservation$/))) {
    return {
      kind: 'pms_manual_reservation',
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase()
    };
  }
  if (m === 'POST' && (match = p.match(/^\/api\/pms\/([^/]+)\/hotels\/([^/]+)\/folios\/([^/]+)\/(charges|payments|adjustments)$/))) {
    return {
      kind: `pms_folio_${match[4]}`,
      brand: decodePart(match[1]).toLowerCase(),
      hotel: decodePart(match[2]).toLowerCase(),
      reservationId: decodePart(match[3]),
      folioOp: match[4]
    };
  }

  // Restaurant / F&B routes
  if (m === 'POST' && (match = p.match(/^\/api\/admin\/orders\/([^/]+)\/requests$/))) {
    return {
      kind: 'orders_create_request',
      brand: decodePart(match[1]).toLowerCase()
    };
  }
  if (m === 'PATCH' && (match = p.match(/^\/api\/admin\/orders\/([^/]+)\/requests\/([^/]+)$/))) {
    return {
      kind: 'orders_edit_request',
      brand: decodePart(match[1]).toLowerCase(),
      requestId: decodePart(match[2])
    };
  }
  if (m === 'PUT' && (match = p.match(/^\/api\/admin\/orders\/([^/]+)\/requests\/([^/]+)\/lifecycle$/))) {
    return {
      kind: 'orders_lifecycle',
      brand: decodePart(match[1]).toLowerCase(),
      requestId: decodePart(match[2])
    };
  }
  if (m === 'PATCH' && (match = p.match(/^\/api\/admin\/orders\/([^/]+)\/locations\/([^/]+)\/operation$/))) {
    return {
      kind: 'orders_location_operation',
      brand: decodePart(match[1]).toLowerCase(),
      locationId: decodePart(match[2])
    };
  }

  return null;
}

function getQueryParam(keyStr, paramName) {
  try {
    const u = new URL(keyStr, 'http://elvador.local');
    return u.searchParams.get(paramName);
  } catch (_) {
    return null;
  }
}

function pmsHotelPrefix(brand, hotel) {
  return `/api/pms/${encodeURIComponent(brand)}/hotels/${encodeURIComponent(hotel)}`;
}

function isFrontOfficeRackKey(key, brand, hotel) {
  const prefix = `${pmsHotelPrefix(brand, hotel)}/front-office`;
  return key === prefix || key.startsWith(`${prefix}?`);
}

function isFrontOfficeHistoryKey(key, brand, hotel) {
  const prefix = `${pmsHotelPrefix(brand, hotel)}/front-office/history`;
  return key === prefix || key.startsWith(`${prefix}?`);
}

function makeAuditId() {
  return `offline_audit_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function appendOptimisticHistory({ cache, brand, hotel, nowIso, auditEntry = null, terminalReservation = null }) {
  if (!auditEntry && !terminalReservation) return;
  cache.mutateMatchingEntries(
    (key) => isFrontOfficeHistoryKey(key, brand, hotel),
    (data) => {
      const nextData = { ...(data && typeof data === 'object' ? data : {}) };
      if (auditEntry) {
        const baseAudit = {
          id: makeAuditId(),
          event: 'unknown',
          category: 'other',
          brand,
          hotel,
          originalAuditId: null,
          reservationId: null,
          roomId: null,
          roomNumber: null,
          fromRoomNumber: null,
          guestName: null,
          guestCount: null,
          roomStatus: null,
          fromStatus: null,
          amountMinor: null,
          currency: null,
          chargeCategory: null,
          paymentMethod: null,
          paymentKind: null,
          reference: null,
          newCheckOut: null,
          actor: { userId: null, username: 'Çevrimdışı', role: null },
          createdAt: nowIso,
          undoInfo: null
        };
        const existingLogs = Array.isArray(nextData.auditLogs) ? nextData.auditLogs : [];
        nextData.auditLogs = [{ ...baseAudit, ...auditEntry }, ...existingLogs];
      }
      if (terminalReservation && terminalReservation.id) {
        const existingRes = Array.isArray(nextData.reservations) ? nextData.reservations : [];
        nextData.reservations = [
          terminalReservation,
          ...existingRes.filter((item) => item?.id !== terminalReservation.id)
        ];
      }
      return nextData;
    }
  );
}

function recomputeRackSummary(data) {
  if (!data || !Array.isArray(data.rooms)) return data;
  const rooms = data.rooms;
  const assignedRoomRows = rooms.filter((r) => r.isAssigned && r.reservation);
  const selectedDate = data.date || new Date().toISOString().slice(0, 10);
  const selectedEndDate = data.endDate || selectedDate;

  return {
    ...data,
    summary: {
      ...(data.summary || {}),
      arrivals: assignedRoomRows.filter((r) => r.reservation.checkIn >= selectedDate && r.reservation.checkIn <= selectedEndDate).length,
      departures: assignedRoomRows.filter((r) => r.isOccupied && r.reservation.checkOut >= selectedDate && r.reservation.checkOut <= selectedEndDate).length,
      inHouse: assignedRoomRows.filter((r) => r.isOccupied).length,
      dirty: rooms.filter((r) => r.roomStatus === 'dirty').length,
      outOfOrder: rooms.filter((r) => r.roomStatus === 'out_of_order').length,
      available: rooms.filter((r) => !r.isAssigned && r.roomStatus === 'clean').length
    }
  };
}

function findReservationSummaryInCache(cache, brand, hotel, reservationId) {
  let found = null;
  cache.mutateMatchingEntries(
    (key) => isFrontOfficeRackKey(key, brand, hotel),
    (data) => {
      if (found) return null;
      if (Array.isArray(data.rooms)) {
        for (const r of data.rooms) {
          if (r.reservation?.id === reservationId) {
            found = r.reservation;
            break;
          }
        }
      }
      if (!found && Array.isArray(data.unassignedReservations)) {
        found = data.unassignedReservations.find((r) => r.id === reservationId) || null;
      }
      if (!found && Array.isArray(data.reservations)) {
        found = data.reservations.find((r) => r.id === reservationId) || null;
      }
      return null;
    }
  );
  return found;
}

function ensureOptimisticFolioInCache(cache, brand, hotel, reservationSummary, nowIso) {
  if (!reservationSummary?.id) return;
  const resId = reservationSummary.id;
  const folioPath = `${pmsHotelPrefix(brand, hotel)}/folios/${encodeURIComponent(resId)}`;
  const existing = cache.get(folioPath);
  if (existing && existing.hit) return;

  const totalMinor = Number.isFinite(Number(reservationSummary.totalPrice))
    ? Math.round(Number(reservationSummary.totalPrice) * 100)
    : 0;
  const folioDoc = {
    id: resId,
    reservationId: resId,
    guestName: reservationSummary.guestName || null,
    roomNumber: reservationSummary.roomAssignment?.roomNumber || null,
    checkIn: reservationSummary.checkIn || null,
    checkOut: reservationSummary.checkOut || null,
    status: 'open',
    currency: 'TRY',
    balanceMinor: totalMinor,
    totalChargesMinor: totalMinor,
    totalPaymentsMinor: 0,
    openedAt: nowIso,
    roomChargeCaptured: totalMinor > 0
  };
  const entries = totalMinor > 0
    ? [{
      id: 'opening_room_charge',
      type: 'charge',
      category: 'room',
      description: 'Accommodation charge',
      amountMinor: totalMinor,
      currency: 'TRY',
      createdAt: nowIso
    }]
    : [];

  cache.set(folioPath, {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, folio: folioDoc, entries }),
    brand,
    optimisticOnly: true
  });

  cache.mutateMatchingEntries(
    (key) => key === `${pmsHotelPrefix(brand, hotel)}/folios`,
    (data) => {
      const list = Array.isArray(data.folios) ? data.folios.slice() : [];
      if (!list.some((f) => f.reservationId === resId)) {
        list.push(folioDoc);
      }
      return { ...data, folios: list };
    }
  );
}

function buildWriteLabel(route, body = {}) {
  switch (route.kind) {
    case 'pms_room_status': return 'Oda Durumu';
    case 'pms_note_create': return (body.roomId || body.roomNumber || body.scope === 'room') ? 'Oda Notu' : 'Genel Not';
    case 'pms_note_delete': return 'Not Silme';
    case 'pms_assign': return 'Oda Atama';
    case 'pms_check_in': return 'Check-in';
    case 'pms_check_out': return 'Check-out';
    case 'pms_move_room': return 'Oda Değişimi';
    case 'pms_update_guests': return 'Misafir Kartı';
    case 'pms_no_show': return 'No-Show';
    case 'pms_extend_stay': return 'Konaklama Uzatma';
    case 'pms_manual_reservation': return 'Yeni Rezervasyon';
    case 'pms_folio_charges': return 'Folyo Harcama';
    case 'pms_folio_payments': return body.paymentKind === 'refund' ? 'Folyo İade' : body.paymentKind === 'deposit' ? 'Ön Ödeme' : 'Folyo Tahsilat';
    case 'pms_folio_adjustments': return 'Folyo Düzeltme';
    case 'orders_create_request': return 'Yeni Sipariş';
    case 'orders_edit_request': return 'Masa Rez. Düzenle';
    case 'orders_lifecycle':
      if (body.action === 'approve') return 'Talep Onayı';
      if (body.action === 'complete') return 'Tamamlama';
      if (body.action === 'reject' || body.action === 'cancel') return 'İptal / Red';
      return 'Sipariş / Rez. Durumu';
    case 'orders_location_operation': return 'Masa İşlemi';
    default: return 'İşlem';
  }
}

function applyOptimisticCacheMutation({ route, body, tempId, cache, nowIso }) {
  const brand = route.brand;
  const hotel = route.hotel;

  if (route.kind === 'pms_room_status') {
    let roomNumber = null;
    let fromStatus = null;
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        if (!Array.isArray(data.rooms)) return null;
        const rooms = data.rooms.map((r) => {
          if (r.id !== route.roomId) return r;
          roomNumber = r.roomNumber;
          if (!fromStatus) fromStatus = r.roomStatus || null;
          return { ...r, roomStatus: body.roomStatus };
        });
        return recomputeRackSummary({ ...data, rooms });
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'room.status_changed',
        category: 'housekeeping',
        roomId: route.roomId,
        roomNumber,
        roomStatus: body.roomStatus || null,
        fromStatus
      }
    });
    return { status: 201, body: { success: true, roomId: route.roomId, roomNumber, roomStatus: body.roomStatus, updatedAt: nowIso } };
  }

  if (route.kind === 'pms_note_create') {
    const scope = (body.roomId || body.roomNumber) ? 'room' : (body.scope === 'room' ? 'room' : 'general');
    const note = {
      id: tempId,
      brand,
      hotel,
      text: String(body.text || '').trim(),
      scope,
      roomId: body.roomId ? String(body.roomId).trim() : null,
      roomNumber: body.roomNumber ? String(body.roomNumber).trim() : (body.roomId ? String(body.roomId).trim() : null),
      reservationId: body.reservationId ? String(body.reservationId).trim() : null,
      createdBy: 'Çevrimdışı',
      createdAt: nowIso
    };
    const notesPrefix = `${pmsHotelPrefix(brand, hotel)}/notes`;
    cache.mutateMatchingEntries(
      (key) => key === notesPrefix || key.startsWith(`${notesPrefix}?`),
      (data, key) => {
        const keyScope = getQueryParam(key, 'scope');
        const keyRoom = getQueryParam(key, 'roomId');
        if (keyScope && keyScope !== note.scope) return null;
        if (keyRoom && String(keyRoom) !== String(note.roomId) && String(keyRoom) !== String(note.roomNumber)) return null;
        const notes = Array.isArray(data.notes) ? [note, ...data.notes] : [note];
        return { ...data, notes };
      }
    );
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        if (note.scope === 'general') {
          return { ...data, summary: { ...(data.summary || {}), notesCount: (data.summary?.notesCount || 0) + 1 } };
        }
        const rooms = Array.isArray(data.rooms)
          ? data.rooms.map((r) => (String(r.id) === String(note.roomId) || String(r.roomNumber) === String(note.roomNumber) ? { ...r, hasNotes: true } : r))
          : data.rooms;
        return { ...data, rooms };
      }
    );
    return { status: 201, body: { success: true, note } };
  }

  if (route.kind === 'pms_note_delete') {
    const notesPrefix = `${pmsHotelPrefix(brand, hotel)}/notes`;
    cache.mutateMatchingEntries(
      (key) => key === notesPrefix || key.startsWith(`${notesPrefix}?`),
      (data) => {
        if (!Array.isArray(data.notes)) return null;
        return { ...data, notes: data.notes.filter((n) => n.id !== route.noteId) };
      }
    );
    return { status: 200, body: { success: true, deleted: true, noteId: route.noteId } };
  }

  if (route.kind === 'pms_assign') {
    let targetRoomNumber = null;
    const resSummary = findReservationSummaryInCache(cache, brand, hotel, body.reservationId);
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rooms = Array.isArray(data.rooms) ? data.rooms.slice() : [];
        const unassigned = Array.isArray(data.unassignedReservations) ? data.unassignedReservations.slice() : [];
        const roomIdx = rooms.findIndex((r) => r.id === body.roomId);
        if (roomIdx >= 0) targetRoomNumber = rooms[roomIdx].roomNumber;

        const targetRes = unassigned.find((r) => r.id === body.reservationId) || resSummary;
        if (targetRes && roomIdx >= 0) {
          const room = rooms[roomIdx];
          const assignedRes = {
            ...targetRes,
            roomAssignment: {
              unitId: body.unitId || targetRes.roomAssignment?.unitId || null,
              roomId: room.id,
              roomNumber: room.roomNumber,
              roomType: room.roomType,
              assignedAt: nowIso
            },
            stay: targetRes.stay || { status: 'assigned', assignedAt: nowIso }
          };
          const rackDate = data.date || new Date().toISOString().slice(0, 10);
          if (!assignedRes.checkIn || !assignedRes.checkOut || (assignedRes.checkIn <= rackDate && rackDate <= assignedRes.checkOut)) {
            rooms[roomIdx] = { ...room, reservation: assignedRes, isAssigned: true };
          }
        }
        const nextUnassigned = unassigned.filter((r) => r.id !== body.reservationId);
        return recomputeRackSummary({ ...data, rooms, unassignedReservations: nextUnassigned });
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'room.assigned',
        category: 'stay',
        reservationId: body.reservationId || null,
        roomId: body.roomId || null,
        roomNumber: targetRoomNumber,
        guestName: resSummary?.guestName || null
      }
    });
    return {
      status: 201,
      body: {
        success: true,
        reservationId: body.reservationId,
        roomId: body.roomId,
        unitId: body.unitId || null,
        roomNumber: targetRoomNumber,
        remainingUnassignedCount: 0
      }
    };
  }

  if (route.kind === 'pms_check_in') {
    let checkedInRes = findReservationSummaryInCache(cache, brand, hotel, body.reservationId);
    let roomNumber = checkedInRes?.roomAssignment?.roomNumber || null;
    let roomId = body.roomId || checkedInRes?.roomAssignment?.roomId || null;
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rooms = Array.isArray(data.rooms) ? data.rooms.map((r) => {
          const matchesRoom = body.roomId ? r.id === body.roomId : (r.reservation?.id === body.reservationId);
          if (!matchesRoom) return r;
          roomNumber = r.roomNumber;
          roomId = r.id;
          const baseRes = r.reservation || checkedInRes;
          if (!baseRes) return r;
          const nextRes = {
            ...baseRes,
            ...(Array.isArray(body.guests) ? { guests: body.guests } : {}),
            ...(body.licensePlate !== undefined ? { licensePlate: body.licensePlate } : {}),
            roomAssignment: baseRes.roomAssignment || { roomId: r.id, roomNumber: r.roomNumber, roomType: r.roomType },
            stay: { status: 'in_house', checkedInAt: nowIso, checkedOutAt: null }
          };
          checkedInRes = nextRes;
          return { ...r, reservation: nextRes, isOccupied: true, isAssigned: true };
        }) : data.rooms;
        const unassigned = Array.isArray(data.unassignedReservations)
          ? data.unassignedReservations.filter((r) => r.id !== body.reservationId)
          : data.unassignedReservations;
        return recomputeRackSummary({ ...data, rooms, unassignedReservations: unassigned });
      }
    );
    if (checkedInRes) {
      ensureOptimisticFolioInCache(cache, brand, hotel, checkedInRes, nowIso);
    }
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'guest.checked_in',
        category: 'stay',
        reservationId: body.reservationId || null,
        roomId,
        roomNumber,
        guestName: checkedInRes?.guestName || null,
        guestCount: Array.isArray(body.guests) ? body.guests.length : (checkedInRes?.adults || null)
      }
    });
    return { status: 201, body: { success: true, reservationId: body.reservationId, roomId: body.roomId || null, roomNumber } };
  }

  if (route.kind === 'pms_check_out') {
    let roomNumber = null;
    let roomId = body.roomId || null;
    let checkedOutRes = null;
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rooms = Array.isArray(data.rooms) ? data.rooms.map((r) => {
          const matches = (body.roomId && r.id === body.roomId) || (body.reservationId && r.reservation?.id === body.reservationId);
          if (!matches) return r;
          roomNumber = r.roomNumber;
          if (!roomId) roomId = r.id;
          if (r.reservation) checkedOutRes = r.reservation;
          return { ...r, reservation: null, isOccupied: false, isAssigned: false, roomStatus: 'dirty' };
        }) : data.rooms;
        return recomputeRackSummary({ ...data, rooms });
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'guest.checked_out',
        category: 'stay',
        reservationId: body.reservationId || checkedOutRes?.id || null,
        roomId: roomId || checkedOutRes?.roomAssignment?.roomId || null,
        roomNumber: roomNumber || checkedOutRes?.roomAssignment?.roomNumber || null,
        guestName: checkedOutRes?.guestName || null
      },
      terminalReservation: checkedOutRes
        ? {
          ...checkedOutRes,
          stay: { ...(checkedOutRes.stay || {}), status: 'checked_out', checkedOutAt: nowIso },
          historyStatus: 'checked_out',
          historyAt: nowIso
        }
        : null
    });
    return { status: 201, body: { success: true, reservationId: body.reservationId, roomId: body.roomId || null, roomNumber } };
  }

  if (route.kind === 'pms_move_room') {
    let targetRoomNumber = null;
    const movingRes = findReservationSummaryInCache(cache, brand, hotel, body.reservationId);
    let fromRoomNumber = movingRes?.roomAssignment?.roomNumber || null;
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rooms = Array.isArray(data.rooms) ? data.rooms.slice() : [];
        const fromIdx = rooms.findIndex((r) => (body.fromRoomId && r.id === body.fromRoomId) || r.reservation?.id === body.reservationId);
        const toIdx = rooms.findIndex((r) => r.id === body.roomId);
        if (fromIdx >= 0 && !fromRoomNumber) fromRoomNumber = rooms[fromIdx].roomNumber || null;
        if (toIdx >= 0) targetRoomNumber = rooms[toIdx].roomNumber;
        const sourceRes = (fromIdx >= 0 ? rooms[fromIdx].reservation : null) || movingRes;
        if (fromIdx >= 0) {
          rooms[fromIdx] = { ...rooms[fromIdx], reservation: null, isOccupied: false, isAssigned: false, roomStatus: 'dirty' };
        }
        if (toIdx >= 0 && sourceRes) {
          const toRoom = rooms[toIdx];
          const updatedRes = {
            ...sourceRes,
            roomAssignment: { ...(sourceRes.roomAssignment || {}), roomId: toRoom.id, roomNumber: toRoom.roomNumber, roomType: toRoom.roomType }
          };
          rooms[toIdx] = {
            ...toRoom,
            reservation: updatedRes,
            isAssigned: true,
            isOccupied: updatedRes.stay?.status === 'in_house'
          };
        }
        return recomputeRackSummary({ ...data, rooms });
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'room.moved',
        category: 'stay',
        reservationId: body.reservationId || null,
        roomId: body.roomId || null,
        roomNumber: targetRoomNumber,
        fromRoomNumber,
        guestName: movingRes?.guestName || null
      }
    });
    return { status: 201, body: { success: true, reservationId: body.reservationId, roomId: body.roomId, roomNumber: targetRoomNumber } };
  }

  if (route.kind === 'pms_update_guests') {
    const resSummary = findReservationSummaryInCache(cache, brand, hotel, route.reservationId);
    const primaryName = Array.isArray(body.guests) ? (body.guests.find((g) => g.isPrimary)?.fullName || body.guests[0]?.fullName) : null;
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const patchRes = (r) => {
          if (!r || r.id !== route.reservationId) return r;
          return {
            ...r,
            ...(Array.isArray(body.guests) ? { guests: body.guests } : {}),
            ...(primaryName ? { guestName: primaryName } : {}),
            ...(body.licensePlate !== undefined ? { licensePlate: body.licensePlate } : {})
          };
        };
        const rooms = Array.isArray(data.rooms)
          ? data.rooms.map((rm) => (rm.reservation?.id === route.reservationId ? { ...rm, reservation: patchRes(rm.reservation) } : rm))
          : data.rooms;
        const unassigned = Array.isArray(data.unassignedReservations)
          ? data.unassignedReservations.map(patchRes)
          : data.unassignedReservations;
        return { ...data, rooms, unassignedReservations: unassigned };
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'reservation.guests_updated',
        category: 'stay',
        reservationId: route.reservationId,
        roomId: resSummary?.roomAssignment?.roomId || null,
        roomNumber: resSummary?.roomAssignment?.roomNumber || null,
        guestName: primaryName || resSummary?.guestName || null,
        guestCount: Array.isArray(body.guests) ? body.guests.length : null
      }
    });
    return { status: 200, body: { success: true, reservationId: route.reservationId, guests: body.guests || [], licensePlate: body.licensePlate ?? null } };
  }

  if (route.kind === 'pms_no_show') {
    let noShowRes = findReservationSummaryInCache(cache, brand, hotel, body.reservationId);
    let roomId = noShowRes?.roomAssignment?.roomId || null;
    let roomNumber = noShowRes?.roomAssignment?.roomNumber || null;
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rooms = Array.isArray(data.rooms)
          ? data.rooms.map((r) => {
            if (r.reservation?.id !== body.reservationId) return r;
            if (!noShowRes) noShowRes = r.reservation;
            if (!roomId) roomId = r.id;
            if (!roomNumber) roomNumber = r.roomNumber;
            return { ...r, reservation: null, isOccupied: false, isAssigned: false };
          })
          : data.rooms;
        const unassigned = Array.isArray(data.unassignedReservations)
          ? data.unassignedReservations.filter((r) => {
            if (r.id === body.reservationId && !noShowRes) noShowRes = r;
            return r.id !== body.reservationId;
          })
          : data.unassignedReservations;
        return recomputeRackSummary({ ...data, rooms, unassignedReservations: unassigned });
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'guest.no_show',
        category: 'stay',
        reservationId: body.reservationId || null,
        roomId,
        roomNumber,
        guestName: noShowRes?.guestName || null
      },
      terminalReservation: noShowRes
        ? {
          ...noShowRes,
          stay: { ...(noShowRes.stay || {}), status: 'no_show', noShowAt: nowIso },
          historyStatus: 'no_show',
          historyAt: nowIso
        }
        : null
    });
    return { status: 200, body: { success: true, reservationId: body.reservationId } };
  }

  if (route.kind === 'pms_extend_stay') {
    const resSummary = findReservationSummaryInCache(cache, brand, hotel, body.reservationId);
    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rooms = Array.isArray(data.rooms)
          ? data.rooms.map((r) => (r.reservation?.id === body.reservationId ? { ...r, reservation: { ...r.reservation, checkOut: body.newCheckOut } } : r))
          : data.rooms;
        const unassigned = Array.isArray(data.unassignedReservations)
          ? data.unassignedReservations.map((r) => (r.id === body.reservationId ? { ...r, checkOut: body.newCheckOut } : r))
          : data.unassignedReservations;
        return { ...data, rooms, unassignedReservations: unassigned };
      }
    );
    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'stay.extended',
        category: 'stay',
        reservationId: body.reservationId || null,
        roomId: resSummary?.roomAssignment?.roomId || null,
        roomNumber: resSummary?.roomAssignment?.roomNumber || null,
        guestName: resSummary?.guestName || null,
        newCheckOut: body.newCheckOut || null
      }
    });
    return { status: 200, body: { success: true, reservationId: body.reservationId, newCheckOut: body.newCheckOut, addedNights: 1 } };
  }

  if (route.kind === 'pms_manual_reservation') {
    const checkInNow = body.checkInNow === true;
    const newRes = {
      id: tempId,
      guestName: body.guestName || 'Walk-in Misafir',
      guestPhone: body.phone || null,
      notes: body.notes || null,
      adults: Number(body.adults) || 1,
      children: Number(body.children) || 0,
      status: 'approved',
      stage: 'approved',
      visibility: 'visible',
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      roomTypes: body.roomType ? [body.roomType] : [],
      roomCount: 1,
      totalPrice: body.overrideTotalPrice ?? null,
      stay: checkInNow
        ? { status: 'in_house', checkedInAt: nowIso, checkedOutAt: null }
        : (body.roomId ? { status: 'assigned', assignedAt: nowIso } : null),
      roomAssignment: body.roomId ? { roomId: body.roomId, roomNumber: null, roomType: body.roomType || null, assignedAt: nowIso } : null
    };

    cache.mutateMatchingEntries(
      (key) => isFrontOfficeRackKey(key, brand, hotel),
      (data) => {
        const rackDate = data.date || new Date().toISOString().slice(0, 10);
        const overlapsRack = !newRes.checkIn || !newRes.checkOut || (newRes.checkIn <= rackDate && rackDate <= newRes.checkOut);
        const rooms = Array.isArray(data.rooms) ? data.rooms.map((r) => {
          if (!body.roomId || r.id !== body.roomId) return r;
          newRes.roomAssignment = { roomId: r.id, roomNumber: r.roomNumber, roomType: r.roomType, assignedAt: nowIso };
          if (!overlapsRack && !checkInNow) return r;
          return { ...r, reservation: newRes, isAssigned: true, isOccupied: checkInNow };
        }) : data.rooms;
        const unassigned = !body.roomId && Array.isArray(data.unassignedReservations)
          ? [newRes, ...data.unassignedReservations]
          : data.unassignedReservations;
        return recomputeRackSummary({ ...data, rooms, unassignedReservations: unassigned });
      }
    );

    if (checkInNow) {
      ensureOptimisticFolioInCache(cache, brand, hotel, newRes, nowIso);
    }

    appendOptimisticHistory({
      cache,
      brand,
      hotel,
      nowIso,
      auditEntry: {
        event: 'reservation.created',
        category: 'stay',
        reservationId: tempId,
        roomId: body.roomId || null,
        roomNumber: newRes.roomAssignment?.roomNumber || null,
        guestName: newRes.guestName
      }
    });
    if (checkInNow) {
      appendOptimisticHistory({
        cache,
        brand,
        hotel,
        nowIso,
        auditEntry: {
          event: 'guest.checked_in',
          category: 'stay',
          reservationId: tempId,
          roomId: body.roomId || null,
          roomNumber: newRes.roomAssignment?.roomNumber || null,
          guestName: newRes.guestName,
          guestCount: newRes.adults
        }
      });
    }

    return {
      status: 201,
      body: {
        success: true,
        reservationId: tempId,
        roomId: body.roomId || null,
        checkIn: body.checkIn,
        checkInNow
      }
    };
  }

  if (route.kind === 'pms_folio_charges' || route.kind === 'pms_folio_payments' || route.kind === 'pms_folio_adjustments') {
    const entryId = makeEntryId();
    const amountMinor = Math.max(0, Number(body.amountMinor) || 0);
    const folioPath = `${pmsHotelPrefix(brand, hotel)}/folios/${encodeURIComponent(route.reservationId)}`;
    const resSummary = findReservationSummaryInCache(cache, brand, hotel, route.reservationId);
    if (resSummary) {
      ensureOptimisticFolioInCache(cache, brand, hotel, resSummary, nowIso);
    }

    const entryType = route.folioOp === 'charges' ? 'charge' : route.folioOp === 'payments' ? 'payment' : 'adjustment';
    const newEntry = {
      id: entryId,
      type: entryType,
      category: body.category || (entryType === 'charge' ? 'manual' : null),
      description: body.description || '',
      amountMinor,
      currency: body.currency || 'TRY',
      paymentMethod: body.paymentMethod || null,
      reference: body.reference || null,
      createdAt: nowIso,
      actor: { username: 'Çevrimdışı' }
    };

    let nextBalanceMinor = 0;
    cache.mutateMatchingEntries(
      (key) => key === folioPath,
      (data) => {
        const folio = data.folio ? { ...data.folio } : { reservationId: route.reservationId, status: 'open', currency: body.currency || 'TRY', balanceMinor: 0, totalChargesMinor: 0, totalPaymentsMinor: 0 };
        if (entryType === 'charge') {
          folio.totalChargesMinor = (Number(folio.totalChargesMinor) || 0) + amountMinor;
          folio.balanceMinor = (Number(folio.balanceMinor) || 0) + amountMinor;
        } else if (entryType === 'payment') {
          if (body.paymentKind === 'refund') {
            folio.totalPaymentsMinor = (Number(folio.totalPaymentsMinor) || 0) - amountMinor;
            folio.balanceMinor = (Number(folio.balanceMinor) || 0) + amountMinor;
          } else {
            folio.totalPaymentsMinor = (Number(folio.totalPaymentsMinor) || 0) + amountMinor;
            folio.balanceMinor = (Number(folio.balanceMinor) || 0) - amountMinor;
          }
        } else if (body.direction === 'credit') {
          folio.balanceMinor = (Number(folio.balanceMinor) || 0) - amountMinor;
        } else {
          folio.totalChargesMinor = (Number(folio.totalChargesMinor) || 0) + amountMinor;
          folio.balanceMinor = (Number(folio.balanceMinor) || 0) + amountMinor;
        }
        nextBalanceMinor = folio.balanceMinor;
        const entries = Array.isArray(data.entries) ? [newEntry, ...data.entries] : [newEntry];
        return { ...data, folio, entries };
      }
    );

    cache.mutateMatchingEntries(
      (key) => key === `${pmsHotelPrefix(brand, hotel)}/folios`,
      (data) => {
        if (!Array.isArray(data.folios)) return null;
        return {
          ...data,
          folios: data.folios.map((f) => (f.reservationId === route.reservationId ? { ...f, balanceMinor: nextBalanceMinor } : f))
        };
      }
    );

    if (entryType === 'charge') {
      appendOptimisticHistory({
        cache,
        brand,
        hotel,
        nowIso,
        auditEntry: {
          event: 'folio.charge_added',
          category: 'folio',
          reservationId: route.reservationId,
          roomNumber: resSummary?.roomAssignment?.roomNumber || null,
          guestName: resSummary?.guestName || null,
          amountMinor,
          currency: body.currency || 'TRY',
          chargeCategory: body.category || 'manual'
        }
      });
    } else if (entryType === 'payment') {
      appendOptimisticHistory({
        cache,
        brand,
        hotel,
        nowIso,
        auditEntry: {
          event: 'payment.recorded',
          category: 'folio',
          reservationId: route.reservationId,
          roomNumber: resSummary?.roomAssignment?.roomNumber || null,
          guestName: resSummary?.guestName || null,
          amountMinor,
          currency: body.currency || 'TRY',
          paymentMethod: body.paymentMethod || null,
          paymentKind: body.paymentKind || null,
          reference: body.reference || null
        }
      });
    } else {
      appendOptimisticHistory({
        cache,
        brand,
        hotel,
        nowIso,
        auditEntry: {
          event: 'folio.adjusted',
          category: 'folio',
          reservationId: route.reservationId,
          roomNumber: resSummary?.roomAssignment?.roomNumber || null,
          guestName: resSummary?.guestName || null,
          amountMinor,
          currency: body.currency || 'TRY'
        }
      });
    }

    return { status: 201, body: { success: true, reservationId: route.reservationId, entryId } };
  }

  // Restaurant / F&B optimistic mutations
  const ordersPrefix = `/api/admin/orders/${encodeURIComponent(brand)}`;

  if (route.kind === 'orders_create_request') {
    const newRequest = {
      id: tempId,
      requestType: 'order',
      brand,
      hotel: body.hotel || 'default',
      tableId: body.tableId || null,
      tableLabel: body.tableLabel || null,
      zone: body.zone || null,
      outletId: body.outletId || null,
      items: Array.isArray(body.items) ? body.items : [],
      notes: body.notes || '',
      currency: body.currency || 'TRY',
      stage: body.stage || 'approved',
      visibility: 'visible',
      createdAt: nowIso
    };
    cache.mutateMatchingEntries(
      (key) => key.startsWith(`${ordersPrefix}/requests`),
      (data, key) => {
        const scope = getQueryParam(key, 'scope');
        if (scope === 'restaurant_reservations') return null;
        const requests = Array.isArray(data.requests) ? [newRequest, ...data.requests] : [newRequest];
        return { ...data, requests };
      }
    );
    return { status: 201, body: { success: true, request: newRequest } };
  }

  if (route.kind === 'orders_edit_request') {
    let updatedResPayload = null;
    cache.mutateMatchingEntries(
      (key) => key.startsWith(`${ordersPrefix}/requests`),
      (data) => {
        if (!Array.isArray(data.requests)) return null;
        const requests = data.requests.map((item) => {
          if (item.id !== route.requestId) return item;
          const currentRes = item.restaurantReservation || item.reservation || {};
          const nextRes = {
            ...currentRes,
            ...(body.date !== undefined ? { date: body.date } : {}),
            ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
            ...(body.sessionName !== undefined ? { sessionName: body.sessionName } : {}),
            ...(body.seatingAreaId !== undefined ? { seatingAreaId: body.seatingAreaId } : {}),
            ...(body.seatingAreaName !== undefined ? { seatingAreaName: body.seatingAreaName } : {}),
            ...(body.partySize !== undefined ? { partySize: body.partySize } : {}),
            ...(body.guestName !== undefined ? { guestName: body.guestName, fullName: body.guestName } : {}),
            ...(body.phone !== undefined ? { phone: body.phone } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {})
          };
          updatedResPayload = nextRes;
          return { ...item, restaurantReservation: nextRes };
        });
        return { ...data, requests };
      }
    );
    return {
      status: 200,
      body: {
        success: true,
        requestId: route.requestId,
        updateData: { restaurantReservation: updatedResPayload || body }
      }
    };
  }

  if (route.kind === 'orders_lifecycle') {
    const action = String(body.action || '').toLowerCase();
    cache.mutateMatchingEntries(
      (key) => key.startsWith(`${ordersPrefix}/requests`),
      (data) => {
        if (!Array.isArray(data.requests)) return null;
        const requests = data.requests.map((item) => {
          if (item.id !== route.requestId) return item;
          if (action === 'approve') return { ...item, stage: 'approved', status: 'pending' };
          if (action === 'complete') return { ...item, stage: 'completed', status: 'completed', ...(body.kitchenStatus ? { kitchenStatus: body.kitchenStatus } : {}) };
          if (action === 'reject' || action === 'cancel') return { ...item, stage: 'cancelled', termination: 'cancelled', status: 'cancelled' };
          if (action === 'kitchen-status') return { ...item, kitchenStatus: body.kitchenStatus };
          if (action === 'toggle-processed-to-folio') return { ...item, processedToFolio: body.processedToFolio };
          return item;
        });
        return { ...data, requests };
      }
    );
    return { status: 200, body: { success: true, requestId: route.requestId, action } };
  }

  if (route.kind === 'orders_location_operation') {
    let updatedLocation = { id: route.locationId, ...body, updatedAt: nowIso };
    if (body.operationalStatus !== undefined && body.operationalStatus !== 'occupied') {
      updatedLocation.operationalOpenedAt = null;
      updatedLocation.operationalPaidAmount = 0;
      updatedLocation.operationalPayments = [];
    }
    cache.mutateMatchingEntries(
      (key) => key.startsWith(`${ordersPrefix}/locations`),
      (data) => {
        if (!Array.isArray(data.locations)) return null;
        const locations = data.locations.map((loc) => {
          if (loc.id !== route.locationId) return loc;
          const nextLoc = {
            ...loc,
            ...body,
            updatedAt: nowIso
          };
          if (body.operationalStatus !== undefined && body.operationalStatus !== 'occupied') {
            nextLoc.operationalOpenedAt = null;
            nextLoc.operationalPaidAmount = 0;
            nextLoc.operationalPayments = [];
          } else if (body.operationalStatus === 'occupied' && !nextLoc.operationalOpenedAt) {
            nextLoc.operationalOpenedAt = nowIso;
          }
          updatedLocation = nextLoc;
          return nextLoc;
        });
        return { ...data, locations };
      }
    );
    return { status: 200, body: { success: true, location: updatedLocation } };
  }

  return { status: 200, body: { success: true } };
}

function applyOfflineWrite({ method, url, body, brand, cache, outbox }) {
  const route = matchAllowlistedRoute(method, url);
  if (!route) {
    return {
      allowed: false,
      status: 503,
      body: {
        success: false,
        offline: true,
        error: 'Bu işlem çevrimdışı modda yapılamaz.',
        message: 'Bu işlem çevrimdışı modda yapılamaz.'
      }
    };
  }

  const normalizedBody = body && typeof body === 'object' ? body : {};
  const nowIso = new Date().toISOString();

  // If deleting a note that hasn't been synced to the server yet, cancel its pending creation cleanly.
  if (route.kind === 'pms_note_delete' && route.noteId.startsWith('offline_note_')) {
    const pendingCreate = outbox.list().find((item) => item.tempId === route.noteId && item.status === 'pending');
    if (pendingCreate) {
      outbox.removeItem(pendingCreate.id);
      const response = applyOptimisticCacheMutation({ route, body: normalizedBody, tempId: null, cache, nowIso });
      return {
        allowed: true,
        status: response.status,
        body: response.body,
        skippedEnqueue: true
      };
    }
  }

  let tempId = null;
  if (route.kind === 'pms_note_create') tempId = makeTempId('offline_note');
  else if (route.kind === 'pms_manual_reservation') tempId = makeTempId('offline_res');
  else if (route.kind === 'orders_create_request') tempId = makeTempId('offline_ord');

  const label = buildWriteLabel(route, normalizedBody);
  const enqueueResult = outbox.enqueue({
    brand: brand || route.brand,
    method: String(method).toUpperCase(),
    url,
    body: normalizedBody,
    label,
    tempId,
    createdAt: nowIso
  });

  if (!enqueueResult.ok) {
    return {
      allowed: false,
      status: 503,
      body: {
        success: false,
        offline: true,
        error: 'Çevrimdışı işlem kuyruğuna kaydedilemedi.',
        message: 'Çevrimdışı işlem kuyruğuna kaydedilemedi.'
      }
    };
  }

  const optimistic = applyOptimisticCacheMutation({
    route,
    body: normalizedBody,
    tempId,
    cache,
    nowIso
  });

  return {
    allowed: true,
    status: optimistic.status,
    body: optimistic.body,
    outboxItem: enqueueResult.item
  };
}

// 2026-11-23: Reset cache to pre-offline baseline and replay surviving outbox items so discarded changes disappear cleanly.
function replayOutboxOnCache({ outbox, cache }) {
  if (!cache || !outbox) {
    return { ok: false, replayedCount: 0 };
  }
  cache.resetToBaseline();
  let replayedCount = 0;
  for (const item of outbox.list()) {
    if (item.status === 'conflict') continue;
    const route = matchAllowlistedRoute(item.method, item.url);
    if (!route) continue;
    applyOptimisticCacheMutation({
      route,
      body: item.body && typeof item.body === 'object' ? item.body : {},
      tempId: item.tempId || null,
      cache,
      nowIso: item.createdAt || new Date().toISOString()
    });
    replayedCount += 1;
  }
  cache.flushSync();
  return { ok: true, replayedCount };
}

module.exports = {
  applyOfflineWrite,
  matchAllowlistedRoute,
  replayOutboxOnCache
};
